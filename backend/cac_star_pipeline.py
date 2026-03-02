"""CAC Star (繁星推薦) history pipeline.

This script downloads CAC history PDFs (錄取標準一覽表) and uses the configured
AI (OPENAI_* env) to extract structured rows for later filtering/compare.

Design goals:
- Incremental: cache per school+page results to resume safely.
- Low-risk defaults: limit pages per PDF unless you explicitly request full.
- Output: a single flat rows JSON suitable for static frontend.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

import fitz  # PyMuPDF

from config import DATA_DIR, REQUEST_DELAY_MS
from cac_star_extractor import extract_star_pdf_page


CAC_BASE = "https://www.cac.edu.tw"

HISTORY_LIST_URL_TMPL = (
    CAC_BASE
    + "/cacportal/star_his_report/{year}/{year}_result_standard/one2seven/collegeList_1.php"
)

STAR_QUERY_URL_TMPL = CAC_BASE + "/star{year}/query.php"


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}


def _ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def _read_json(path: str) -> Optional[dict]:
    try:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path: str, obj: Any):
    _ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def _norm_school_code(s: str) -> str:
    raw = str(s or "").strip()
    m = re.search(r"\b([0-9]{3})\b", raw)
    return m.group(1) if m else raw


def _norm_program_code(s: Any) -> str:
    raw = str(s or "").strip()
    m = re.search(r"\b([0-9]{5})\b", raw)
    return m.group(1) if m else raw


def _norm_percent(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace("%", "")
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None
    return None


@dataclass
class SchoolPdf:
    year: int
    school_code: str
    school_name: str
    pdf_url: str


async def fetch_html(client: httpx.AsyncClient, url: str) -> str:
    resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=60)
    resp.raise_for_status()
    return resp.text


def parse_history_list(html: str, list_url: str, year: int) -> List[SchoolPdf]:
    soup = BeautifulSoup(html or "", "lxml")
    out: List[SchoolPdf] = []
    seen = set()

    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        if not href:
            continue
        if ".pdf" not in href.lower():
            continue

        text = a.get_text(" ", strip=True)
        m = re.match(r"^\((\d{3})\)\s*(.+?)\s*$", text)
        school_code = m.group(1) if m else ""
        school_name = m.group(2).strip() if m else text

        pdf_url = urljoin(list_url, href)
        school_code = _norm_school_code(school_code)
        key = (int(year), school_code, pdf_url)
        if key in seen:
            continue
        seen.add(key)

        if not school_code:
            # last resort: try extract from url
            m2 = re.search(r"Standard_(\d{3})\.pdf", pdf_url)
            if m2:
                school_code = m2.group(1)

        out.append(
            SchoolPdf(
                year=int(year),
                school_code=str(school_code),
                school_name=str(school_name),
                pdf_url=str(pdf_url),
            )
        )

    out.sort(key=lambda x: (x.year, x.school_code))
    return out


def discover_star_system_dir(query_html: str, star_year: int) -> str:
    # query.php contains links like: ./system/ColQry_115xStarFoRstU_XXXX/SGroup1.htm
    y = int(star_year)
    pat = re.compile(r"\./system/(ColQry_" + str(y) + r"[^/]+)/SGroup1\.htm")
    m = pat.search(query_html or "")
    if m:
        return m.group(1)

    # fallback: any ColQry_{year} directory
    pat2 = re.compile(r"\./system/(ColQry_" + str(y) + r"[^/]+)/")
    m2 = pat2.search(query_html or "")
    if m2:
        return m2.group(1)

    raise RuntimeError(f"无法从 query.php 发现 ColQry_{y} 系统目录")


def parse_sgroup_catalog(html: str, group_id: int) -> Dict[str, dict]:
    soup = BeautifulSoup(html or "", "lxml")
    out: Dict[str, dict] = {}

    # The pages commonly use <b>学校名<br>系名 (00101)</b>
    for b in soup.find_all(["b", "strong"]):
        t = b.get_text("\n", strip=True)
        if not t:
            continue
        m = re.search(r"\(([0-9]{5})\)", t)
        if not m:
            continue
        code = m.group(1)
        parts = [p.strip() for p in t.split("\n") if p and p.strip()]
        school_name = parts[0] if parts else ""
        line = ""
        for p in parts:
            if f"({code})" in p:
                line = p
                break
        if not line and parts:
            line = parts[-1]
        program_name = line.replace(f"({code})", "").strip()

        if code in out:
            continue
        out[code] = {
            "program_code": code,
            "school_name": school_name,
            "program_name": program_name,
            "group": int(group_id),
        }

    return out


async def build_program_catalog(
    *,
    client: httpx.AsyncClient,
    star_year: int,
    groups: List[int],
    out_path: str,
) -> Dict[str, dict]:
    qurl = STAR_QUERY_URL_TMPL.format(year=int(star_year))
    qhtml = await fetch_html(client, qurl)
    sys_dir = discover_star_system_dir(qhtml, star_year)

    catalog: Dict[str, dict] = {}
    for gid in groups:
        gurl = f"{CAC_BASE}/star{int(star_year)}/system/{sys_dir}/SGroup{int(gid)}.htm"
        html = await fetch_html(client, gurl)
        part = parse_sgroup_catalog(html, gid)
        for k, v in part.items():
            if k not in catalog:
                catalog[k] = v
        await asyncio.sleep(0.2)

    payload = {
        "generated_at": datetime.now().isoformat(),
        "star_year": int(star_year),
        "groups": [int(x) for x in groups],
        "count": len(catalog),
        "items": catalog,
        "source": qurl,
    }
    _write_json(out_path, payload)
    return catalog


async def download_pdf(
    *,
    client: httpx.AsyncClient,
    pdf_url: str,
    save_path: str,
    force: bool,
    delay_ms: int,
):
    if not force and os.path.exists(save_path) and os.path.getsize(save_path) > 0:
        return

    resp = await client.get(
        pdf_url, headers=HEADERS, follow_redirects=True, timeout=120
    )
    resp.raise_for_status()
    _ensure_dir(os.path.dirname(save_path))
    with open(save_path, "wb") as f:
        f.write(resp.content)

    if delay_ms > 0:
        await asyncio.sleep(delay_ms / 1000.0)


def extract_pdf_pages_text(pdf_path: str) -> List[str]:
    doc = fitz.open(pdf_path)
    try:
        pages = []
        for i in range(doc.page_count):
            pages.append(doc.load_page(i).get_text("text") or "")
        return pages
    finally:
        doc.close()


async def process_school_pdf(
    *,
    client: httpx.AsyncClient,
    item: SchoolPdf,
    program_catalog: Dict[str, dict],
    base_dir: str,
    force_pdf: bool,
    force_ai: bool,
    delay_ms: int,
    max_pages: int,
) -> Dict[str, Any]:
    year = int(item.year)
    school_code = _norm_school_code(item.school_code)
    school_name = str(item.school_name)

    pdf_path = os.path.join(base_dir, "pdfs", str(year), f"{school_code}.pdf")
    await download_pdf(
        client=client,
        pdf_url=item.pdf_url,
        save_path=pdf_path,
        force=force_pdf,
        delay_ms=delay_ms,
    )

    pages_text = extract_pdf_pages_text(pdf_path)
    if max_pages and max_pages > 0:
        pages_text = pages_text[:max_pages]

    cache_root = os.path.join(base_dir, "cache", str(year), str(school_code))
    _ensure_dir(cache_root)

    all_rows: List[dict] = []
    page_errors: List[dict] = []

    for idx, text in enumerate(pages_text, start=1):
        page_cache = os.path.join(cache_root, f"page_{idx:02d}.json")
        cached = _read_json(page_cache) if (not force_ai) else None
        if cached and isinstance(cached, dict) and "rows" in cached:
            page_obj = cached
        else:
            page_obj = await extract_star_pdf_page(
                year=year,
                school_code=school_code,
                school_name=school_name,
                page=idx,
                content=text,
            )
            page_obj["cached_at"] = datetime.now().isoformat()
            _write_json(page_cache, page_obj)
            if delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000.0)

        if not isinstance(page_obj, dict):
            page_errors.append({"page": idx, "error": "page_obj异常"})
            continue

        if page_obj.get("error"):
            page_errors.append({"page": idx, "error": page_obj.get("error")})

        rows = page_obj.get("rows")
        if not isinstance(rows, list):
            rows = []

        for r in rows:
            if not isinstance(r, dict):
                continue

            prog_code = _norm_program_code(r.get("program_code"))
            if not prog_code:
                continue
            r["program_code"] = prog_code

            # attach metadata
            r["year"] = year
            r["school_code"] = school_code
            r["school_name"] = school_name
            r["source_pdf_url"] = item.pdf_url
            r["source_page"] = idx

            # normalize percent
            rp = _norm_percent(r.get("school_rank_percent"))
            r["school_rank_percent"] = rp

            # fill program names from catalog if missing
            cat = program_catalog.get(prog_code)
            if isinstance(cat, dict):
                if not (
                    isinstance(r.get("program_name"), str)
                    and r.get("program_name").strip()
                ):
                    r["program_name"] = cat.get("program_name") or r.get("program_name")
                r["catalog_group"] = cat.get("group")
                r["catalog_school_name"] = cat.get("school_name")

            all_rows.append(r)

    status = "success" if all_rows else "empty"
    if page_errors and not all_rows:
        status = "failed"

    combined = {
        "year": year,
        "school_code": school_code,
        "school_name": school_name,
        "pdf_url": item.pdf_url,
        "pages": len(pages_text),
        "rows": all_rows,
        "status": status,
        "errors": page_errors,
        "updated_at": datetime.now().isoformat(),
    }

    _write_json(os.path.join(cache_root, "combined.json"), combined)
    return combined


def _parse_years(raw: str) -> List[int]:
    out = []
    for part in re.split(r"[ ,;]+", str(raw or "").strip()):
        if not part:
            continue
        if not re.fullmatch(r"\d{3}", part):
            raise ValueError(f"非法 year: {part}")
        out.append(int(part))
    return sorted(list(dict.fromkeys(out)))


def _parse_school_codes(raw: str) -> List[str]:
    if not raw:
        return []
    out = []
    for part in re.split(r"[ ,;]+", str(raw or "").strip()):
        if not part:
            continue
        code = _norm_school_code(part)
        if not re.fullmatch(r"\d{3}", code):
            raise ValueError(f"非法 school code: {part}")
        out.append(code)
    return sorted(list(dict.fromkeys(out)))


async def main():
    parser = argparse.ArgumentParser(
        description="CAC 繁星推薦(历史) PDF -> JSON pipeline"
    )
    parser.add_argument(
        "--years",
        default="112,113,114",
        help="历史年度(民国年)，逗号分隔。默认: 112,113,114",
    )
    parser.add_argument(
        "--schools",
        default="",
        help="仅处理指定学校代码(3位)，逗号分隔。例如: 001,013,153",
    )
    parser.add_argument(
        "--max-schools",
        type=int,
        default=0,
        help="最多处理多少所学校（0=全部）",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=2,
        help="每个 PDF 最多处理多少页（默认2页；0=全部页）",
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=int(REQUEST_DELAY_MS),
        help="请求/AI 调用间隔（毫秒），用于避免触发限流",
    )
    parser.add_argument(
        "--force-pdf",
        action="store_true",
        help="强制重新下载 PDF（忽略本地缓存）",
    )
    parser.add_argument(
        "--force-ai",
        action="store_true",
        help="强制重新跑 AI（忽略缓存的 page_*.json）",
    )
    parser.add_argument(
        "--refresh-catalog",
        action="store_true",
        help="强制刷新校系目录映射（默认使用缓存文件）",
    )
    parser.add_argument(
        "--catalog-year",
        type=int,
        default=115,
        help="用于补全 program_name 的目录年度（默认115）",
    )
    parser.add_argument(
        "--out",
        default="",
        help="输出 JSON 路径（默认写入 data/cac_star/history_<years>.json）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只列出将要处理的 PDF 列表，不下载/不跑AI",
    )

    args = parser.parse_args()
    years = _parse_years(args.years)
    only_schools = set(_parse_school_codes(args.schools))
    max_schools = int(args.max_schools or 0)
    max_pages = int(args.max_pages or 0)
    delay_ms = int(args.delay_ms or 0)
    catalog_year = int(args.catalog_year)

    base_dir = os.path.join(DATA_DIR, "cac_star")
    _ensure_dir(base_dir)

    years_str = "_".join(str(y) for y in years)
    out_path = args.out.strip() or os.path.join(base_dir, f"history_{years_str}.json")

    async with httpx.AsyncClient(timeout=120) as client:
        # Load or build program catalog
        catalog_path = os.path.join(base_dir, f"program_catalog_{catalog_year}.json")
        catalog_payload = None if args.refresh_catalog else _read_json(catalog_path)
        if isinstance(catalog_payload, dict) and isinstance(
            catalog_payload.get("items"), dict
        ):
            program_catalog = catalog_payload["items"]
        else:
            program_catalog = await build_program_catalog(
                client=client,
                star_year=catalog_year,
                groups=[1, 2, 3, 4, 5, 6, 7],
                out_path=catalog_path,
            )

        # Collect PDFs
        school_pdfs: List[SchoolPdf] = []
        for y in years:
            list_url = HISTORY_LIST_URL_TMPL.format(year=int(y))
            html = await fetch_html(client, list_url)
            items = parse_history_list(html, list_url, y)
            if only_schools:
                items = [it for it in items if it.school_code in only_schools]
            school_pdfs.extend(items)
            await asyncio.sleep(0.2)

        school_pdfs.sort(key=lambda x: (x.year, x.school_code))
        if max_schools and max_schools > 0:
            school_pdfs = school_pdfs[:max_schools]

        if args.dry_run:
            print(f"[dry-run] years={years} schools={len(school_pdfs)}")
            for it in school_pdfs:
                print(f"{it.year} {it.school_code} {it.school_name} {it.pdf_url}")
            return

        # Process
        combined_results: List[dict] = []
        all_rows: List[dict] = []

        for idx, it in enumerate(school_pdfs, start=1):
            print(
                f"[{idx}/{len(school_pdfs)}] {it.year} {it.school_code} {it.school_name}"
            )
            res = await process_school_pdf(
                client=client,
                item=it,
                program_catalog=program_catalog,
                base_dir=base_dir,
                force_pdf=bool(args.force_pdf),
                force_ai=bool(args.force_ai),
                delay_ms=delay_ms,
                max_pages=max_pages,
            )
            combined_results.append(res)
            rows = res.get("rows")
            if isinstance(rows, list):
                all_rows.extend([r for r in rows if isinstance(r, dict)])

        payload = {
            "generated_at": datetime.now().isoformat(),
            "source": "CAC star_his_report PDFs (one2seven)",
            "years": years,
            "catalog_year": catalog_year,
            "schools": [
                {
                    "year": r.get("year"),
                    "school_code": r.get("school_code"),
                    "school_name": r.get("school_name"),
                    "pdf_url": r.get("pdf_url"),
                    "pages": r.get("pages"),
                    "status": r.get("status"),
                    "row_count": len(r.get("rows") or [])
                    if isinstance(r.get("rows"), list)
                    else 0,
                }
                for r in combined_results
                if isinstance(r, dict)
            ],
            "rows": all_rows,
        }

        _write_json(out_path, payload)
        print(f"输出完成: {out_path} (rows={len(all_rows)})")


if __name__ == "__main__":
    asyncio.run(main())
