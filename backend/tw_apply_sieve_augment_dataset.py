"""Augment tw_star_apply_dataset.json with Apply historical sieve cutoffs.

Adds per-program field:
  apply_sieve_history: { "112": {...}, "113": {...}, "114": {...} }

Data source:
  CAC apply_his_report/{year}/{year}_sieve_standard/report/pict/{school}.png

OCR:
  Uses Windows built-in OCR via `winsdk`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import datetime
from typing import Any, Dict

import httpx

from config import DATA_DIR, REQUEST_DELAY_MS
from cac_apply_sieve_history import (
    HEADERS,
    SIEVE_LIST_URL_TMPL,
    detect_right_columns_from_image_bytes,
    extract_sieve_rows_from_words,
    merge_year_maps,
    now_iso,
    ocr_words_windows,
    parse_school_codes_from_college_list,
)


def _ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def _read_json(path: str) -> Any:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path: str, obj: Any):
    _ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


async def _sleep_ms(ms: int):
    await asyncio.sleep(max(0, int(ms)) / 1000.0)


async def fetch_text(client: httpx.AsyncClient, url: str, *, delay_ms: int) -> str:
    resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=90)
    resp.raise_for_status()
    if delay_ms:
        await _sleep_ms(delay_ms)
    return resp.text


async def download_bytes(
    client: httpx.AsyncClient, url: str, *, delay_ms: int
) -> bytes:
    resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=120)
    resp.raise_for_status()
    if delay_ms:
        await _sleep_ms(delay_ms)
    return resp.content


async def build_apply_sieve_year(
    *,
    client: httpx.AsyncClient,
    year: int,
    delay_ms: int,
    cache_dir: str,
) -> Dict[str, Dict[str, Any]]:
    year = int(year)
    cache_path = os.path.join(cache_dir, f"apply_sieve_{year}.json")
    cached = _read_json(cache_path)
    if isinstance(cached, dict) and isinstance(cached.get("items"), dict):
        return cached["items"]

    list_url = SIEVE_LIST_URL_TMPL.format(year=year)
    html = await fetch_text(client, list_url, delay_ms=delay_ms)
    schools = parse_school_codes_from_college_list(html, list_url)

    school_cache_dir = os.path.join(cache_dir, "apply_sieve", str(year))
    _ensure_dir(school_cache_dir)

    items: Dict[str, Dict[str, Any]] = {}
    for idx, (school_code, img_url) in enumerate(schools, start=1):
        sc = str(school_code)
        school_cache = os.path.join(school_cache_dir, f"{sc}.json")
        school_cached = _read_json(school_cache)
        if isinstance(school_cached, dict) and isinstance(
            school_cached.get("items"), dict
        ):
            merge_year_maps(
                items,
                school_cached["items"],
                year=year,
                school_code=sc,
                source_image=img_url,
            )
            continue

        print(f"apply sieve {year} [{idx}/{len(schools)}] school {sc}")
        try:
            img_bytes = await download_bytes(client, img_url, delay_ms=delay_ms)
        except Exception as e:
            _write_json(
                school_cache,
                {
                    "generated_at": now_iso(),
                    "year": year,
                    "school_code": sc,
                    "source_image": img_url,
                    "error": str(e),
                    "items": {},
                },
            )
            continue

        try:
            right_cols = detect_right_columns_from_image_bytes(img_bytes)
            words_cells = await ocr_words_windows(img_bytes, lang_tag="zh-Hans-CN")
            words_code = await ocr_words_windows(img_bytes, lang_tag="en-GB")
            row_map = extract_sieve_rows_from_words(
                words_cells, right_cols=right_cols, code_words=words_code
            )
        except Exception as e:
            _write_json(
                school_cache,
                {
                    "generated_at": now_iso(),
                    "year": year,
                    "school_code": sc,
                    "source_image": img_url,
                    "error": str(e),
                    "items": {},
                },
            )
            continue

        _write_json(
            school_cache,
            {
                "generated_at": now_iso(),
                "year": year,
                "school_code": sc,
                "source_image": img_url,
                "items": row_map,
            },
        )
        merge_year_maps(items, row_map, year=year, school_code=sc, source_image=img_url)

    _write_json(
        cache_path,
        {
            "generated_at": now_iso(),
            "year": year,
            "source": "cacportal apply_his_report sieve_standard png",
            "items": items,
        },
    )
    return items


async def main():
    ap = argparse.ArgumentParser(description="Augment dataset with apply sieve history")
    ap.add_argument(
        "--dataset",
        default=os.path.join(DATA_DIR, "cac_star", "tw_star_apply_dataset.json"),
        help="dataset json path",
    )
    ap.add_argument(
        "--delay-ms",
        type=int,
        default=int(REQUEST_DELAY_MS),
        help="delay between requests",
    )
    ap.add_argument(
        "--years",
        default="112,113,114",
        help="history years (comma separated)",
    )
    args = ap.parse_args()

    dataset_path = os.path.abspath(args.dataset)
    if not os.path.exists(dataset_path):
        raise SystemExit(f"dataset not found: {dataset_path}")

    years = [int(x.strip()) for x in str(args.years).split(",") if x.strip()]
    delay_ms = int(args.delay_ms)

    with open(dataset_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("programs"), dict):
        raise SystemExit("invalid dataset format")

    cache_dir = os.path.join(DATA_DIR, "cac_star", "cache")
    _ensure_dir(cache_dir)

    sieve_by_year: Dict[int, Dict[str, Dict[str, Any]]] = {}
    async with httpx.AsyncClient(timeout=120) as client:
        for y in years:
            sieve_by_year[int(y)] = await build_apply_sieve_year(
                client=client,
                year=int(y),
                delay_ms=delay_ms,
                cache_dir=cache_dir,
            )

    # Attach per program
    programs = data.get("programs") or {}
    for pcode, prog in programs.items():
        if not isinstance(prog, dict):
            continue
        apply_code = str(prog.get("apply_code") or "").strip()
        if not apply_code:
            continue

        existing = prog.get("apply_sieve_history")
        hist = existing if isinstance(existing, dict) else {}
        hist2 = dict(hist)
        for y in years:
            ent = sieve_by_year.get(int(y), {}).get(apply_code)
            if ent:
                hist2[str(y)] = ent
        prog["apply_sieve_history"] = hist2

    prev_years = data.get("apply_sieve_years")
    prev_years = prev_years if isinstance(prev_years, list) else []
    merged_years = sorted(
        {int(x) for x in (prev_years + years) if str(x).strip().isdigit()}
    )
    data["apply_sieve_years"] = merged_years
    data["apply_sieve_generated_at"] = datetime.now().isoformat()

    out_path = dataset_path
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"done: {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
