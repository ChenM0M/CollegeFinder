"""Update majors list in results.json by re-fetching pages.

This script only fetches web pages / attachments and extracts the list of
available majors ("招生专业") using rule-based parsing.

It does NOT call the AI extractor, so it can be used to backfill majors for
already-extracted results without spending tokens.

Usage:
  python update_majors_only.py
  python update_majors_only.py --concurrency 6 --max-links 4
  python update_majors_only.py --no-skip-existing
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx

from config import RESULTS_FILE, SCHOOLS_FILE, CONCURRENCY, REQUEST_DELAY_MS
from fetcher import (
    HEADERS,
    fetch_page_content,
    fetch_related_content,
    normalize_fetch_url,
)
from main import (
    _is_probable_major_name,
    _normalize_major_name,
    extract_majors_from_department_label,
    extract_majors_from_text,
    load_results,
    save_results,
)


def _merge_unique_str_list(
    a: Optional[list], b: Optional[list], limit: int = 800
) -> list:
    out: List[str] = []
    seen = set()
    for arr in (a, b):
        if not isinstance(arr, list):
            continue
        for x in arr:
            if not isinstance(x, str):
                continue
            s = x.strip()
            if not s or s in seen:
                continue
            seen.add(s)
            out.append(s)
            if len(out) >= limit:
                return out
    return out


def _clean_major_list(items: Optional[list], limit: int = 400) -> list:
    out: List[str] = []
    seen = set()
    if not isinstance(items, list):
        return out
    for x in items:
        if not isinstance(x, str):
            continue
        nm = _normalize_major_name(x)
        if not nm:
            continue
        if not _is_probable_major_name(nm):
            continue
        if nm in seen:
            continue
        seen.add(nm)
        out.append(nm)
        if len(out) >= limit:
            break
    return out


def load_schools_map() -> Dict[str, dict]:
    if not os.path.exists(SCHOOLS_FILE):
        return {}
    with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
        schools = json.load(f)
    mp = {}
    if isinstance(schools, list):
        for s in schools:
            if not isinstance(s, dict):
                continue
            sid = str(s.get("id") or "").strip()
            if sid:
                mp[sid] = s
    return mp


def choose_fetch_url(sid: str, result: dict, schools_map: Dict[str, dict]) -> str:
    src = (result.get("source_url") or "").strip()
    if src:
        return normalize_fetch_url(src)
    school = schools_map.get(sid) or {}
    z = (school.get("zsjz_url") or "").strip()
    return normalize_fetch_url(z)


def should_process(result: dict, skip_existing: bool) -> bool:
    if not isinstance(result, dict):
        return False
    if (result.get("status") or "") != "success":
        return False
    ext = result.get("extraction")
    if not isinstance(ext, dict) or not ext.get("found"):
        return False
    if skip_existing and isinstance(ext.get("majors"), list) and ext.get("majors"):
        return False
    return True


def patch_department_majors(ext: dict):
    depts = ext.get("department_requirements")
    if not isinstance(depts, list):
        return

    for row in depts:
        if not isinstance(row, dict):
            continue
        cur = row.get("majors")
        if isinstance(cur, list) and cur:
            continue
        label = row.get("department")
        if not isinstance(label, str) or not label.strip():
            continue
        majors = extract_majors_from_department_label(label)
        if majors:
            row["majors"] = majors


async def fetch_text_bundle(
    url: str,
    client: httpx.AsyncClient,
    school_name: str = "",
    max_links: int = 4,
    fetch_attachments: int = 2,
) -> Tuple[str, Dict[str, Any]]:
    meta: Dict[str, Any] = {
        "url": url,
        "attachments_fetched": 0,
        "related_links_used": 0,
        "errors": [],
    }

    page = await fetch_page_content(url, client)
    if not page.get("success"):
        meta["errors"].append(page.get("error") or "fetch_failed")
        return "", meta

    text_parts = []
    base_text = (page.get("text") or "").strip()
    if base_text:
        text_parts.append(base_text)

    # Fetch a couple of attachments from the main page if present
    pdf_links = page.get("pdf_links") or []
    if isinstance(pdf_links, list) and pdf_links and fetch_attachments > 0:
        for item in pdf_links[: max(1, fetch_attachments)]:
            try:
                u = (item or {}).get("url")
                if not isinstance(u, str) or not u.strip():
                    continue
                await asyncio.sleep(REQUEST_DELAY_MS / 1000)
                sub = await fetch_page_content(u.strip(), client)
                if sub.get("success") and (sub.get("text") or "").strip():
                    meta["attachments_fetched"] += 1
                    text_parts.append(
                        f"\n\n--- 附件内容: {u.strip()} ---\n" + sub.get("text", "")
                    )
            except Exception as e:
                meta["errors"].append(f"attachment_error: {e}")
            if meta["attachments_fetched"] >= fetch_attachments:
                break

    # Follow related links (list/navigation pages)
    html = page.get("html")
    if isinstance(html, str) and html.strip() and max_links > 0:
        try:
            related = await fetch_related_content(
                url,
                html,
                client,
                school_name=school_name,
                max_links=max_links,
            )
            if related.get("success") and (related.get("text") or "").strip():
                used = related.get("links") or []
                if isinstance(used, list):
                    meta["related_links_used"] = len(used)
                text_parts.append(
                    "\n\n--- 关联子链接补充 ---\n" + related.get("text", "")
                )
        except Exception as e:
            meta["errors"].append(f"related_error: {e}")

    bundle = "\n".join([p for p in text_parts if p and p.strip()]).strip()
    return bundle, meta


async def run(args: argparse.Namespace) -> int:
    schools_map = load_schools_map()
    results = load_results()
    schools = results.get("schools") or {}
    if not isinstance(schools, dict):
        print("results.json 结构异常: schools 不是对象")
        return 2

    candidates: List[Tuple[str, dict]] = []
    for sid, r in schools.items():
        sid2 = str(sid)
        if should_process(r, skip_existing=args.skip_existing):
            candidates.append((sid2, r))

    total = len(candidates)
    if total == 0:
        print("没有需要更新 majors 的学校（可能都已填充，或没有 success/found 结果）")
        return 0

    report = {
        "run_at": datetime.now().isoformat(),
        "total_candidates": total,
        "processed": 0,
        "updated": 0,
        "majors_present_after": 0,
        "errors": 0,
        "items": [],
    }

    semaphore = asyncio.Semaphore(args.concurrency)
    lock = asyncio.Lock()

    async with httpx.AsyncClient(
        headers=HEADERS,
        timeout=60,
        follow_redirects=True,
        verify=False,
    ) as client:

        async def worker(idx: int, sid: str, r: dict):
            nonlocal results
            school_name = str(r.get("school_name") or "")
            url = choose_fetch_url(sid, r, schools_map)

            item = {
                "school_id": sid,
                "school_name": school_name,
                "url": url,
                "majors_before": 0,
                "majors_after": 0,
                "attachments_fetched": 0,
                "related_links_used": 0,
                "error": None,
            }

            ext = r.get("extraction")
            if isinstance(ext, dict) and isinstance(ext.get("majors"), list):
                item["majors_before"] = len(ext.get("majors") or [])

            if not url:
                item["error"] = "no_url"
                async with lock:
                    report["processed"] += 1
                    report["errors"] += 1
                    report["items"].append(item)
                return

            try:
                async with semaphore:
                    bundle, meta = await fetch_text_bundle(
                        url,
                        client,
                        school_name=school_name,
                        max_links=args.max_links,
                        fetch_attachments=args.fetch_attachments,
                    )

                item["attachments_fetched"] = meta.get("attachments_fetched", 0)
                item["related_links_used"] = meta.get("related_links_used", 0)

                majors_new = extract_majors_from_text(bundle)

                async with lock:
                    ext2 = r.get("extraction")
                    if not isinstance(ext2, dict):
                        ext2 = {}
                        r["extraction"] = ext2

                    before = (
                        ext2.get("majors")
                        if isinstance(ext2.get("majors"), list)
                        else []
                    )

                    if getattr(args, "replace_existing", False):
                        if majors_new:
                            ext2["majors"] = _merge_unique_str_list([], majors_new)
                        else:
                            # 抓取为空：对旧 majors 做一次清洗，避免保留明显噪声
                            cleaned_before = _clean_major_list(before)
                            if cleaned_before:
                                ext2["majors"] = cleaned_before
                            else:
                                ext2.pop("majors", None)
                    else:
                        merged = _merge_unique_str_list(before, majors_new)
                        if merged:
                            ext2["majors"] = merged

                    patch_department_majors(ext2)

                    after = (
                        ext2.get("majors")
                        if isinstance(ext2.get("majors"), list)
                        else []
                    )
                    item["majors_after"] = len(after)

                    report["processed"] += 1
                    if item["majors_after"] > item["majors_before"]:
                        report["updated"] += 1
                    if item["majors_after"] > 0:
                        report["majors_present_after"] += 1

                    report["items"].append(item)

                    # persist periodically
                    if report["processed"] % max(5, args.save_every) == 0:
                        save_results(results)

                if args.verbose and (idx % 1 == 0):
                    print(
                        f"[{idx}/{total}] {school_name} majors: {item['majors_before']} -> {item['majors_after']} (att={item['attachments_fetched']}, rel={item['related_links_used']})"
                    )
                elif idx % 25 == 0 or idx == total:
                    print(
                        f"[{idx}/{total}] progress: updated={report['updated']} majors_present={report['majors_present_after']} errors={report['errors']}"
                    )

            except Exception as e:
                item["error"] = str(e)
                async with lock:
                    report["processed"] += 1
                    report["errors"] += 1
                    report["items"].append(item)
                if args.verbose:
                    print(f"[{idx}/{total}] {school_name} ERROR: {e}")

        tasks = []
        for i, (sid, r) in enumerate(candidates, start=1):
            tasks.append(worker(i, sid, r))

        await asyncio.gather(*tasks)

    # final save
    save_results(results)

    report_path = os.path.join(
        os.path.dirname(RESULTS_FILE), "majors_update_report.json"
    )
    try:
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"写入报告失败: {e}")

    print(
        "\n".join(
            [
                "majors 回填完成:",
                f"- 候选学校: {total}",
                f"- 已处理: {report['processed']}",
                f"- majors 新增更新: {report['updated']}",
                f"- majors 最终非空: {report['majors_present_after']}",
                f"- 错误: {report['errors']}",
                f"- 详细报告: {report_path}",
            ]
        )
    )

    return 0 if report["errors"] == 0 else 1


def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Backfill majors into results.json")
    p.add_argument("--concurrency", type=int, default=CONCURRENCY, help="并发数")
    p.add_argument("--max-links", type=int, default=4, help="追踪关联子链接数量")
    p.add_argument(
        "--fetch-attachments", type=int, default=2, help="主页面附件抓取数量"
    )
    p.add_argument(
        "--no-skip-existing",
        action="store_true",
        help="不跳过已有 majors 的记录",
    )
    p.add_argument(
        "--replace-existing",
        action="store_true",
        help="用本次抓取结果覆盖已有 majors（抓取为空则保留原值）",
    )
    p.add_argument(
        "--save-every",
        type=int,
        default=10,
        help="每处理 N 所学校保存一次 results.json",
    )
    p.add_argument("--verbose", action="store_true", help="输出每所学校处理细节")
    return p


def main():
    parser = build_argparser()
    args = parser.parse_args()
    args.skip_existing = not args.no_skip_existing
    if args.concurrency <= 0:
        args.concurrency = 1
    if args.max_links < 0:
        args.max_links = 0
    if args.fetch_attachments < 0:
        args.fetch_attachments = 0
    if args.save_every <= 0:
        args.save_every = 10
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
