import asyncio
import json
from pathlib import Path
from urllib.parse import urlparse

import httpx

from fetcher import HEADERS
from main import (
    LOW_QUALITY_HOST_HINTS,
    choose_better_result,
    load_results,
    process_school,
    save_results,
)


ROOT = Path(__file__).resolve().parents[1]
SCHOOLS_FILE = ROOT / "data" / "schools.json"


def is_low_quality(url: str) -> bool:
    host = urlparse((url or "").strip()).netloc.lower()
    return any(h in host for h in LOW_QUALITY_HOST_HINTS)


async def run() -> None:
    results = load_results()
    schools_map = {}
    with SCHOOLS_FILE.open("r", encoding="utf-8") as f:
        for s in json.load(f):
            schools_map[str(s.get("id"))] = s

    target_ids = []
    for sid, item in (results.get("schools") or {}).items():
        if item.get("status") != "not_found":
            continue
        if not is_low_quality(item.get("source_url") or ""):
            continue
        if sid in schools_map:
            target_ids.append(sid)

    if not target_ids:
        print(json.dumps({"processed": 0, "updated": 0}, ensure_ascii=False))
        return

    processed = 0
    updated = 0
    async with httpx.AsyncClient(
        headers=HEADERS, timeout=60, follow_redirects=True, verify=False
    ) as client:
        for sid in target_ids:
            school = schools_map[sid]
            new_result = await process_school(school, client, use_search_fallback=False)
            old_result = (results.get("schools") or {}).get(sid)
            chosen = choose_better_result(old_result, new_result)
            (results.get("schools") or {})[sid] = chosen
            processed += 1
            if chosen is not old_result:
                updated += 1

    save_results(results)
    print(
        json.dumps(
            {
                "processed": processed,
                "updated": updated,
                "target_ids": len(target_ids),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(run())
