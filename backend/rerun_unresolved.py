import argparse
import asyncio
import json
from datetime import datetime
from pathlib import Path

import httpx

from fetcher import HEADERS


ROOT = Path(__file__).resolve().parents[1]
SCHOOLS_FILE = ROOT / "data" / "schools.json"
RESULTS_FILE = ROOT / "data" / "results.json"


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


async def main_async(statuses: set[str], concurrency: int, limit: int | None) -> None:
    # Import from backend/main.py (same folder) to reuse processing logic.
    from main import choose_better_result, process_school

    schools = load_json(SCHOOLS_FILE)
    schools_map = {str(s.get("id")): s for s in schools if isinstance(s, dict)}

    results = load_json(RESULTS_FILE)
    results_map = results.get("schools") or {}

    target_ids = [
        sid
        for sid, item in results_map.items()
        if isinstance(item, dict) and (item.get("status") in statuses)
    ]

    if limit is not None:
        target_ids = target_ids[: max(0, limit)]

    total = len(target_ids)
    if total == 0:
        print(
            json.dumps({"processed": 0, "updated": 0, "total": 0}, ensure_ascii=False)
        )
        return

    sem = asyncio.Semaphore(max(1, int(concurrency)))
    lock = asyncio.Lock()

    processed = 0
    updated = 0
    started_at = datetime.now().isoformat()

    async with httpx.AsyncClient(
        headers=HEADERS, timeout=60, follow_redirects=True, verify=False
    ) as client:

        async def worker(sid: str):
            nonlocal processed, updated

            school = schools_map.get(sid)
            if not school:
                async with lock:
                    processed += 1
                return

            async with sem:
                try:
                    new_result = await process_school(
                        school, client, use_search_fallback=True
                    )
                except Exception as e:
                    new_result = {
                        "school_id": sid,
                        "school_name": school.get("name") or "",
                        "area": school.get("area") or "",
                        "type": school.get("type") or "",
                        "tier": school.get("tier") or "",
                        "taiwan_recognized": school.get("taiwan_recognized"),
                        "processed_at": datetime.now().isoformat(),
                        "source_url": school.get("zsjz_url"),
                        "source": "official",
                        "extraction": {
                            "found": False,
                            "error": str(e),
                            "confidence": "low",
                            "school_name": school.get("name") or "",
                        },
                        "status": "failed",
                        "raw_text_length": 0,
                    }

            async with lock:
                old_result = results_map.get(sid)
                chosen = choose_better_result(old_result, new_result)
                results_map[sid] = chosen
                processed += 1
                if chosen is not old_result:
                    updated += 1

                if processed % 10 == 0 or processed == total:
                    results["schools"] = results_map
                    results["last_updated"] = datetime.now().isoformat()
                    save_json(RESULTS_FILE, results)

                    print(
                        json.dumps(
                            {
                                "progress": processed,
                                "total": total,
                                "updated": updated,
                                "started_at": started_at,
                            },
                            ensure_ascii=False,
                        )
                    )

        await asyncio.gather(*[worker(sid) for sid in target_ids])

    results["schools"] = results_map
    results["last_updated"] = datetime.now().isoformat()
    save_json(RESULTS_FILE, results)

    print(
        json.dumps(
            {
                "processed": processed,
                "updated": updated,
                "total": total,
                "statuses": sorted(statuses),
            },
            ensure_ascii=False,
        )
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Rerun unresolved (failed/not_found) schools"
    )
    p.add_argument(
        "--statuses",
        default="failed,not_found",
        help="Comma-separated statuses to rerun (default: failed,not_found)",
    )
    p.add_argument(
        "--concurrency",
        type=int,
        default=3,
        help="Concurrent workers (default: 3)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of schools to rerun",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()
    statuses = set(s.strip() for s in (args.statuses or "").split(",") if s.strip())
    asyncio.run(main_async(statuses, args.concurrency, args.limit))


if __name__ == "__main__":
    main()
