"""Build Taiwan Star + Apply dataset.

Default scope:
- Star groups: 1/2/3/5/8
- History years: 112-114
- Current year: 115

Outputs a single JSON file with:
- Star current requirements + tie-break items (from star{year}/system/.../html)
- Star history cutoffs (from CAC history PDFs) as boundary vectors for rounds 1/2
- Apply current stage-1 screening requirements (from apply{year}/system/.../html)
- Apply history distribution minimum status (from apply_his_report/*/entrance_standard)

The script is resumable via on-disk caches in data/cac_star/cache/.
PDFs and caches are gitignored.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup
import fitz  # PyMuPDF

from config import DATA_DIR, REQUEST_DELAY_MS


CAC_BASE = "https://www.cac.edu.tw"

STAR_QUERY_URL_TMPL = CAC_BASE + "/star{year}/query.php"
APPLY_QUERY_URL_TMPL = CAC_BASE + "/apply{year}/query.php"

STAR_SGROUP_URL_TMPL = CAC_BASE + "/star{year}/system/{sys_dir}/SGroup{gid}.htm"
STAR_DETAIL_URL_TMPL = (
    CAC_BASE + "/star{year}/system/{sys_dir}/html/{year}_{code}.htm?v=1.0"
)

APPLY_DETAIL_URL_TMPL = (
    CAC_BASE + "/apply{year}/system/{sys_dir}/html/{year}_{code}.htm?v=1.0"
)

STAR_HIS_LIST_ONE2SEVEN_TMPL = (
    CAC_BASE
    + "/cacportal/star_his_report/{year}/{year}_result_standard/one2seven/collegeList_1.php"
)
STAR_HIS_LIST_EIGHT_TMPL = (
    CAC_BASE
    + "/cacportal/star_his_report/{year}/{year}_result_standard/eight/collegeList_1.php"
)

APPLY_HIS_ENTRANCE_INDEX_TMPL = (
    CAC_BASE
    + "/cacportal/apply_his_report/{year}/{year}_entrance_standard/standard_index.php"
)


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}


STAR_GROUPS_DEFAULT = [1, 2, 3, 5, 8]
HISTORY_YEARS_DEFAULT = [112, 113, 114]


def _ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def _read_json(path: str) -> Optional[Any]:
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


def _sleep_ms(ms: int):
    return asyncio.sleep(max(0, int(ms)) / 1000.0)


async def fetch_text(
    client: httpx.AsyncClient,
    url: str,
    *,
    delay_ms: int,
    max_retries: int = 5,
) -> str:
    backoff = 1.0
    last_err = None
    for attempt in range(max_retries):
        try:
            resp = await client.get(
                url, headers=HEADERS, follow_redirects=True, timeout=90
            )
            if resp.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP {resp.status_code}")
            resp.raise_for_status()
            if delay_ms:
                await _sleep_ms(delay_ms)
            return resp.text
        except Exception as e:
            last_err = e
            await asyncio.sleep(backoff)
            backoff = min(20.0, backoff * 1.6)
    raise RuntimeError(f"fetch failed: {url}: {last_err}")


async def download_bytes(
    client: httpx.AsyncClient,
    url: str,
    *,
    delay_ms: int,
    max_retries: int = 5,
) -> bytes:
    backoff = 1.0
    last_err = None
    for attempt in range(max_retries):
        try:
            resp = await client.get(
                url, headers=HEADERS, follow_redirects=True, timeout=120
            )
            if resp.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP {resp.status_code}")
            resp.raise_for_status()
            if delay_ms:
                await _sleep_ms(delay_ms)
            return resp.content
        except Exception as e:
            last_err = e
            await asyncio.sleep(backoff)
            backoff = min(30.0, backoff * 1.6)
    raise RuntimeError(f"download failed: {url}: {last_err}")


def discover_system_dir(query_html: str, year: int, kind: str) -> str:
    # kind: 'star' or 'apply'
    y = int(year)
    if kind == "star":
        pat = re.compile(r"\./system/(ColQry_" + str(y) + r"[^/]+)/SGroup1\.htm")
        m = pat.search(query_html or "")
        if m:
            return m.group(1)
        pat2 = re.compile(r"\./system/(ColQry_" + str(y) + r"[^/]+)/")
        m2 = pat2.search(query_html or "")
        if m2:
            return m2.group(1)
    elif kind == "apply":
        pat = re.compile(r"\./system/(ColQry_" + str(y) + r"apply[^/]+)/")
        m = pat.search(query_html or "")
        if m:
            return m.group(1)
        pat2 = re.compile(r"\./system/(ColQry_" + str(y) + r"[^/]+)/QrybyStu")
        m2 = pat2.search(query_html or "")
        if m2:
            return m2.group(1)
        pat3 = re.compile(r"\./system/(ColQry_" + str(y) + r"[^/]+)/")
        m3 = pat3.search(query_html or "")
        if m3:
            return m3.group(1)
    else:
        raise ValueError("unknown kind")

    raise RuntimeError(f"无法从 query.php 发现系统目录: {kind}{y}")


def _split_br_text(el: Any) -> List[str]:
    if not el:
        return []
    text = el.get_text("\n", strip=True)
    parts = [p.strip() for p in text.splitlines() if p and p.strip()]
    return parts


def parse_star_sgroup(html: str, group_id: int, year: int) -> Dict[str, Dict[str, Any]]:
    soup = BeautifulSoup(html or "", "lxml")
    out: Dict[str, Dict[str, Any]] = {}

    # Prefer links to detail pages, which always include the code.
    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        m = re.search(r"/html/%d_(\d{5})\.htm" % int(year), href) or re.search(
            r"\./html/%d_(\d{5})\.htm" % int(year), href
        )
        if not m:
            continue
        code = m.group(1)

        # Find nearest bold text containing school + program
        container = a
        bold = None
        for _ in range(6):
            if not container:
                break
            bold = container.find_previous(["b", "strong"])
            if bold and re.search(
                r"\(%s\)" % re.escape(code), bold.get_text(" ", strip=True)
            ):
                break
            container = container.parent

        school_name = ""
        program_name = ""
        if bold:
            t = bold.get_text("\n", strip=True)
            lines = [x.strip() for x in t.split("\n") if x and x.strip()]
            if lines:
                school_name = lines[0]
                # find the line that contains (code)
                line = next((ln for ln in lines if f"({code})" in ln), lines[-1])
                program_name = line.replace(f"({code})", "").strip()

        out[code] = {
            "program_code": code,
            "school_code": code[:3],
            "school_name": school_name,
            "program_name": program_name,
            "group": int(group_id),
        }

    return out


def parse_star_detail(html: str) -> Dict[str, Any]:
    soup = BeautifulSoup(html or "", "lxml")

    school_name = ""
    program_name = ""
    code = ""

    col = soup.select_one(".colname")
    if col:
        school_name = col.get_text(" ", strip=True)
    gsd = soup.select_one(".gsdname")
    if gsd:
        program_name = gsd.get_text(" ", strip=True)

    # code appears in a red cell in the 3rd row
    for td in soup.find_all("td"):
        t = td.get_text(" ", strip=True)
        if re.fullmatch(r"\d{5}", t):
            code = t
            break

    # subjects + standards are two adjacent rowspanned cells with <br>
    subjects: List[str] = []
    standards: List[str] = []
    for td in soup.find_all("td"):
        t = td.get_text("\n", strip=True)
        if "國文" in t and "英文" in t and "數學" in t:
            subjects = [x.strip() for x in t.splitlines() if x and x.strip()]
            nxt = td.find_next_sibling("td")
            if nxt:
                standards = [
                    x.strip()
                    for x in nxt.get_text("\n", strip=True).splitlines()
                    if x and x.strip()
                ]
            break

    req_map: Dict[str, Optional[str]] = {}
    for s, st in zip(subjects, standards):
        req_map[s] = st

    # tie-break items: a td containing lines "1、..."
    tie_items: List[str] = []
    for td in soup.find_all("td"):
        t = td.get_text("\n", strip=True)
        if "1、" in t and "2、" in t and "分發比序" not in t:
            lines = [x.strip() for x in t.splitlines() if x and x.strip()]
            if len(lines) >= 2:
                for ln in lines:
                    ln2 = re.sub(r"^[0-9]+、", "", ln).strip()
                    if ln2:
                        tie_items.append(ln2)
                if tie_items:
                    break

    # group name
    group_name = ""
    for tr in soup.find_all("tr"):
        t = tr.get_text(" ", strip=True)
        if "學群類別" in t:
            tds = tr.find_all("td")
            if len(tds) >= 2:
                group_name = tds[1].get_text(" ", strip=True)
            break

    return {
        "program_code": code,
        "school_name": school_name,
        "program_name": program_name,
        "group_name": group_name,
        "requirements": req_map,
        "tie_break_items": tie_items,
    }


def parse_apply_detail(html: str) -> Dict[str, Any]:
    soup = BeautifulSoup(html or "", "lxml")
    school_name = ""
    program_name = ""
    code = ""

    col = soup.select_one(".colname")
    if col:
        school_name = col.get_text(" ", strip=True)
    gsd = soup.select_one(".gsdname")
    if gsd:
        program_name = gsd.get_text(" ", strip=True)

    for td in soup.find_all("td"):
        t = td.get_text(" ", strip=True)
        if re.fullmatch(r"\d{6}", t):
            code = t
            break

    subjects: List[str] = []
    standards: List[str] = []
    mults: List[str] = []

    # Find the stage-1 rowspanned subject list
    for td in soup.find_all("td"):
        t = td.get_text("\n", strip=True)
        if "國文" in t and "英文" in t and "篩選" not in t and "檢定" not in t:
            parts = [x.strip() for x in t.splitlines() if x and x.strip()]
            if len(parts) >= 3 and all(p in parts for p in ["國文", "英文"]):
                subjects = parts
                td_std = td.find_next_sibling("td")
                td_mul = td_std.find_next_sibling("td") if td_std else None
                if td_std:
                    standards = [
                        x.strip()
                        for x in td_std.get_text("\n", strip=True).splitlines()
                        if x and x.strip()
                    ]
                if td_mul:
                    mults = [
                        x.strip()
                        for x in td_mul.get_text("\n", strip=True).splitlines()
                        if x and x.strip()
                    ]
                break

    stage1: List[Dict[str, Any]] = []
    for i, s in enumerate(subjects):
        stage1.append(
            {
                "subject": s,
                "standard": standards[i] if i < len(standards) else None,
                "multiplier": mults[i] if i < len(mults) else None,
            }
        )

    tie_break = ""
    for tr in soup.find_all("tr"):
        t = tr.get_text(" ", strip=True)
        if "同級分" in t and "超額篩選" in t:
            tds = tr.find_all("td")
            if tds:
                tie_break = tds[-1].get_text(" ", strip=True)
            break

    return {
        "program_code": code,
        "school_name": school_name,
        "program_name": program_name,
        "stage1": stage1,
        "tie_break": tie_break,
    }


def _cluster_lines_by_y(words: List[Tuple], *, y_tol: float = 1.2) -> List[float]:
    ys = sorted([float(w[1]) for w in words])
    if not ys:
        return []
    clusters: List[List[float]] = [[ys[0]]]
    for y in ys[1:]:
        if abs(y - clusters[-1][-1]) <= y_tol:
            clusters[-1].append(y)
        else:
            clusters.append([y])
    return [sum(c) / len(c) for c in clusters]


def _parse_value_token(tok: str) -> Optional[Any]:
    s = str(tok or "").strip()
    if not s or s in ("--", "-", "無", "无"):
        return None
    if s.endswith("%"):
        try:
            return float(s[:-1])
        except Exception:
            return s
    if re.fullmatch(r"\d+", s):
        try:
            return int(s)
        except Exception:
            return s
    if re.fullmatch(r"\d+\.\d+", s):
        try:
            return float(s)
        except Exception:
            return s
    return s


def parse_star_history_pdf(pdf_path: str, year: int) -> Dict[str, List[Dict[str, Any]]]:
    doc = fitz.open(pdf_path)
    try:
        out: Dict[str, List[Dict[str, Any]]] = {}
        for pidx in range(doc.page_count):
            page = doc.load_page(pidx)
            words = page.get_text("words")

            prog_words = [
                w
                for w in words
                if w
                and isinstance(w[4], str)
                and re.fullmatch(r"\d{5}", w[4].strip())
                and float(w[0]) < 160
            ]

            for w in prog_words:
                code = w[4].strip()
                y_code = float(w[1])

                y0 = y_code - 40
                y1 = y_code + 40
                label_words = [
                    ww
                    for ww in words
                    if y0 <= float(ww[1]) <= y1 and 560 <= float(ww[0]) <= 670
                ]
                line_ys = _cluster_lines_by_y(label_words)
                if not line_ys:
                    continue

                round1_vals: List[Optional[Any]] = []
                round2_vals: List[Optional[Any]] = []

                for ly in line_ys:
                    r1 = [
                        ww
                        for ww in words
                        if abs(float(ww[1]) - ly) <= 2.0
                        and 690 <= float(ww[0]) <= 760
                        and isinstance(ww[4], str)
                    ]
                    r2 = [
                        ww
                        for ww in words
                        if abs(float(ww[1]) - ly) <= 2.0
                        and 770 <= float(ww[0]) <= 820
                        and isinstance(ww[4], str)
                    ]
                    r1.sort(key=lambda x: float(x[0]))
                    r2.sort(key=lambda x: float(x[0]))

                    v1 = _parse_value_token(r1[0][4] if r1 else "")
                    v2 = _parse_value_token(r2[0][4] if r2 else "")
                    round1_vals.append(v1)
                    round2_vals.append(v2)

                out.setdefault(code, []).append(
                    {
                        "year": int(year),
                        "program_code": code,
                        "school_code": code[:3],
                        "page": int(pidx + 1),
                        "round1": round1_vals,
                        "round2": round2_vals,
                    }
                )

        return out
    finally:
        doc.close()


def _pick_best_history_entry(entries: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not entries:
        return None

    def score(e: Dict[str, Any]) -> Tuple[int, int]:
        r1 = e.get("round1")
        r2 = e.get("round2")
        r1 = r1 if isinstance(r1, list) else []
        r2 = r2 if isinstance(r2, list) else []
        filled = sum(1 for v in r1 if v is not None) + sum(
            1 for v in r2 if v is not None
        )
        has_first = 1 if (len(r1) > 0 and r1[0] is not None) else 0
        return (filled, has_first)

    best = max(entries, key=score)
    return best


async def build_apply_history_distribution(
    *,
    client: httpx.AsyncClient,
    year: int,
    delay_ms: int,
    cache_dir: str,
) -> Dict[str, Dict[str, Any]]:
    cache_path = os.path.join(cache_dir, f"apply_dist_{year}.json")
    cached = _read_json(cache_path)
    if isinstance(cached, dict) and isinstance(cached.get("items"), dict):
        return cached["items"]

    index_url = APPLY_HIS_ENTRANCE_INDEX_TMPL.format(year=int(year))
    index_html = await fetch_text(client, index_url, delay_ms=delay_ms)
    soup = BeautifulSoup(index_html, "lxml")

    school_links = []
    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        m = re.search(r"standard_(\d{3})\.html", href)
        if not m:
            continue
        school_code = m.group(1)
        school_name = a.get_text(" ", strip=True)
        school_links.append((school_code, school_name, urljoin(index_url, href)))

    items: Dict[str, Dict[str, Any]] = {}
    for school_code, school_name, url in school_links:
        html = await fetch_text(client, url, delay_ms=delay_ms)
        soup2 = BeautifulSoup(html, "lxml")
        table = soup2.find("table")
        if not table:
            continue
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if len(tds) < 6:
                continue
            code = tds[0].get_text(" ", strip=True)
            if not re.fullmatch(r"\d{6}", code or ""):
                continue
            dept = tds[1].get_text(" ", strip=True)
            quota_type = tds[2].get_text(" ", strip=True)
            min_std = tds[5].get_text(" ", strip=True)

            items[code] = {
                "year": int(year),
                "school_code": school_code,
                "school_name": school_name,
                "dept_name": dept,
                "quota_type": quota_type,
                "min_distribution": min_std,
                "source": url,
            }

    _write_json(
        cache_path,
        {"generated_at": datetime.now().isoformat(), "year": int(year), "items": items},
    )
    return items


async def main():
    parser = argparse.ArgumentParser(
        description="Build Star+Apply dataset (groups 1/2/3/5/8)"
    )
    parser.add_argument(
        "--star-year", type=int, default=115, help="current star year (default 115)"
    )
    parser.add_argument(
        "--apply-year", type=int, default=115, help="current apply year (default 115)"
    )
    parser.add_argument(
        "--history-years", default="112,113,114", help="history years, comma separated"
    )
    parser.add_argument(
        "--groups", default="1,2,3,5,8", help="star groups, comma separated"
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=int(REQUEST_DELAY_MS),
        help="delay between requests",
    )
    parser.add_argument("--out", default="", help="output json path")
    parser.add_argument(
        "--max-programs", type=int, default=0, help="limit programs for quick run"
    )
    args = parser.parse_args()

    star_year = int(args.star_year)
    apply_year = int(args.apply_year)
    delay_ms = int(args.delay_ms)

    history_years = [
        int(x.strip()) for x in str(args.history_years).split(",") if x.strip()
    ]
    groups = [int(x.strip()) for x in str(args.groups).split(",") if x.strip()]

    base_dir = os.path.join(DATA_DIR, "cac_star")
    cache_dir = os.path.join(base_dir, "cache")
    pdf_dir = os.path.join(base_dir, "pdfs")
    _ensure_dir(cache_dir)
    _ensure_dir(pdf_dir)

    out_path = args.out.strip() or os.path.join(base_dir, "tw_star_apply_dataset.json")

    async with httpx.AsyncClient(timeout=120) as client:
        # Discover system dirs
        star_query_html = await fetch_text(
            client, STAR_QUERY_URL_TMPL.format(year=star_year), delay_ms=delay_ms
        )
        star_sys_dir = discover_system_dir(star_query_html, star_year, "star")

        apply_query_html = await fetch_text(
            client, APPLY_QUERY_URL_TMPL.format(year=apply_year), delay_ms=delay_ms
        )
        apply_sys_dir = discover_system_dir(apply_query_html, apply_year, "apply")

        # Build star program catalog (selected groups)
        program_catalog: Dict[str, Dict[str, Any]] = {}
        for gid in groups:
            sgroup_url = STAR_SGROUP_URL_TMPL.format(
                year=star_year, sys_dir=star_sys_dir, gid=gid
            )
            html = await fetch_text(client, sgroup_url, delay_ms=delay_ms)
            part = parse_star_sgroup(html, gid, star_year)
            for k, v in part.items():
                program_catalog.setdefault(k, v)

        codes = sorted(program_catalog.keys())
        if args.max_programs and int(args.max_programs) > 0:
            codes = codes[: int(args.max_programs)]

        print(f"star{star_year}: groups={groups} programs={len(codes)}")

        # Star current details
        star_details: Dict[str, Dict[str, Any]] = {}
        for idx, code in enumerate(codes, start=1):
            if idx == 1 or idx % 200 == 0 or idx == len(codes):
                print(f"star detail [{idx}/{len(codes)}] {code}")
            cache_path = os.path.join(cache_dir, "star", str(star_year), f"{code}.json")
            cached = _read_json(cache_path)
            if isinstance(cached, dict) and cached.get("program_code"):
                star_details[code] = cached
                continue

            url = STAR_DETAIL_URL_TMPL.format(
                year=star_year, sys_dir=star_sys_dir, code=code
            )
            try:
                html = await fetch_text(client, url, delay_ms=delay_ms)
            except Exception as e:
                star_details[code] = {"program_code": code, "error": str(e)}
                _write_json(cache_path, star_details[code])
                continue

            det = parse_star_detail(html)
            star_details[code] = det
            _write_json(cache_path, det)

        # Star history cutoffs from PDFs
        star_history: Dict[int, Dict[str, Dict[str, Any]]] = {}
        for hy in history_years:
            print(f"star history year {hy}...")
            year_map: Dict[str, Dict[str, Any]] = {}
            for kind, list_url_tmpl in (
                ("one2seven", STAR_HIS_LIST_ONE2SEVEN_TMPL),
                ("eight", STAR_HIS_LIST_EIGHT_TMPL),
            ):
                print(f"  list {kind}...")
                list_url = list_url_tmpl.format(year=int(hy))
                list_html = await fetch_text(client, list_url, delay_ms=delay_ms)
                soup = BeautifulSoup(list_html, "lxml")
                for a in soup.find_all("a", href=True):
                    href = (a.get("href") or "").strip()
                    if not href.lower().endswith(".pdf"):
                        continue
                    m = re.search(r"\((\d{3})\)", a.get_text(" ", strip=True) or "")
                    school_code = m.group(1) if m else ""
                    pdf_url = urljoin(list_url, href)
                    if not school_code:
                        m2 = re.search(r"Standard_(\d{3})\.pdf", pdf_url)
                        if m2:
                            school_code = m2.group(1)
                    if not school_code:
                        continue

                    save_path = os.path.join(
                        pdf_dir, str(hy), kind, f"{school_code}.pdf"
                    )
                    if not os.path.exists(save_path) or os.path.getsize(save_path) == 0:
                        print(f"    download pdf {hy}/{kind}/{school_code}...")
                        data = await download_bytes(client, pdf_url, delay_ms=delay_ms)
                        _ensure_dir(os.path.dirname(save_path))
                        with open(save_path, "wb") as f:
                            f.write(data)

                    pdf_cache = os.path.join(
                        cache_dir, "star_history", str(hy), kind, f"{school_code}.json"
                    )
                    cached = _read_json(pdf_cache)
                    if isinstance(cached, dict) and isinstance(
                        cached.get("items"), dict
                    ):
                        parsed = cached["items"]
                    else:
                        print(f"    parse pdf {hy}/{kind}/{school_code}...")
                        parsed = parse_star_history_pdf(save_path, hy)
                        _write_json(
                            pdf_cache,
                            {
                                "generated_at": datetime.now().isoformat(),
                                "year": int(hy),
                                "kind": kind,
                                "school_code": school_code,
                                "pdf_url": pdf_url,
                                "items": parsed,
                            },
                        )

                    # select best entry per program
                    for pcode, entries in (parsed or {}).items():
                        if not isinstance(pcode, str) or not re.fullmatch(
                            r"\d{5}", pcode
                        ):
                            continue
                        best = _pick_best_history_entry(
                            entries if isinstance(entries, list) else []
                        )
                        if not best:
                            continue
                        best2 = dict(best)
                        best2["kind"] = kind
                        best2["school_code"] = school_code
                        year_map[pcode] = best2

            star_history[int(hy)] = year_map

        # Apply current details for mapped codes
        apply_details: Dict[str, Dict[str, Any]] = {}
        for idx, star_code in enumerate(codes, start=1):
            if idx == 1 or idx % 200 == 0 or idx == len(codes):
                print(f"apply detail [{idx}/{len(codes)}] {star_code} -> {star_code}2")
            apply_code = f"{star_code}2"
            cache_path = os.path.join(
                cache_dir, "apply", str(apply_year), f"{apply_code}.json"
            )
            cached = _read_json(cache_path)
            if isinstance(cached, dict) and cached.get("program_code"):
                apply_details[star_code] = cached
                continue

            url = APPLY_DETAIL_URL_TMPL.format(
                year=apply_year, sys_dir=apply_sys_dir, code=apply_code
            )
            try:
                html = await fetch_text(client, url, delay_ms=delay_ms)
            except Exception as e:
                err = {"program_code": apply_code, "error": str(e)}
                apply_details[star_code] = err
                _write_json(cache_path, err)
                continue
            det = parse_apply_detail(html)
            apply_details[star_code] = det
            _write_json(cache_path, det)

        # Apply history distribution (min distribution standard)
        apply_history_dist: Dict[int, Dict[str, Dict[str, Any]]] = {}
        for hy in history_years:
            print(f"apply history distribution {hy}...")
            dist = await build_apply_history_distribution(
                client=client,
                year=int(hy),
                delay_ms=delay_ms,
                cache_dir=cache_dir,
            )
            apply_history_dist[int(hy)] = dist

        # Compose final dataset
        programs: Dict[str, Any] = {}
        for code in codes:
            cat = program_catalog.get(code, {})
            star_det = star_details.get(code, {})
            app_det = apply_details.get(code, {})

            hist: Dict[str, Any] = {}
            for hy in history_years:
                hmap = star_history.get(int(hy), {})
                if isinstance(hmap, dict) and code in hmap:
                    hist[str(hy)] = hmap[code]

            apply_hist: Dict[str, Any] = {}
            apply_code = f"{code}2"
            for hy in history_years:
                dist = apply_history_dist.get(int(hy), {})
                if isinstance(dist, dict) and apply_code in dist:
                    apply_hist[str(hy)] = dist[apply_code]

            programs[code] = {
                "program_code": code,
                "school_code": code[:3],
                "star_group": cat.get("group"),
                "school_name": (
                    cat.get("school_name") or star_det.get("school_name") or ""
                ),
                "program_name": (
                    cat.get("program_name") or star_det.get("program_name") or ""
                ),
                "star_current": star_det,
                "star_history": hist,
                "apply_code": apply_code,
                "apply_current": app_det,
                "apply_history": apply_hist,
            }

        payload = {
            "generated_at": datetime.now().isoformat(),
            "star_year": star_year,
            "apply_year": apply_year,
            "star_sys_dir": star_sys_dir,
            "apply_sys_dir": apply_sys_dir,
            "history_years": history_years,
            "groups": groups,
            "program_count": len(programs),
            "programs": programs,
        }

        _write_json(out_path, payload)
        print(f"done: {out_path} programs={len(programs)}")


if __name__ == "__main__":
    asyncio.run(main())
