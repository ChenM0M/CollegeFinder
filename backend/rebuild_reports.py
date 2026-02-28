import csv
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
RESULTS_FILE = DATA_DIR / "results.json"
RETRY_SUMMARY_FILE = DATA_DIR / "retry_summary.json"
FOLLOWUP_FILE = DATA_DIR / "manual_followup_report.json"
UNRESOLVED_FILE = DATA_DIR / "unresolved_schools.csv"
SCHOOLS_FILE = DATA_DIR / "schools.json"

SUBJECT_KEYS = ["chinese", "english", "math_a", "math_b", "social", "science"]
LOW_QUALITY_HOST_HINTS = [
    "zhihu.com",
    "zhidao.baidu.com",
    "jingyan.baidu.com",
    "baike.baidu.com",
    "wikipedia.org",
    "reddit.com",
    "microsoft.com",
    "google.com",
    "techcommunity.microsoft.com",
    "39.net",
    "commentcamarche.net",
    "policyx.com",
    "kabu-sokuhou.com",
    "lahoratime.com",
    "ncert.nic.in",
    "tinhte.vn",
]


def has_subject_requirements(extraction: dict) -> bool:
    if not isinstance(extraction, dict):
        return False

    gen = extraction.get("general_requirements") or {}
    for k in SUBJECT_KEYS:
        v = gen.get(k) or {}
        if v.get("standard") or v.get("min_score"):
            return True

    for row in extraction.get("department_requirements") or []:
        if not isinstance(row, dict):
            continue
        subjects = row.get("subjects") or {}
        for k in SUBJECT_KEYS:
            v = subjects.get(k) or {}
            if v.get("standard") or v.get("min_score"):
                return True

    return False


def recategorize_short_content_failures(results: dict) -> int:
    short_pattern = re.compile(r"内容过短|为空|未找到有效内容|无法获取招生简章内容")
    changed = 0

    for item in (results.get("schools") or {}).values():
        if item.get("status") != "failed":
            continue

        extraction = item.get("extraction") or {}
        err = extraction.get("error") or item.get("error") or ""
        if not short_pattern.search(err):
            continue

        item["status"] = "not_found"
        extraction["found"] = False
        extraction["error"] = None
        notes = (extraction.get("notes") or "").strip()
        reason = "内容过短或未命中2026台湾学测简章正文"
        extraction["notes"] = reason if not notes else f"{notes} {reason}"
        item["extraction"] = extraction
        item.pop("error", None)
        changed += 1

    return changed


def low_quality_host(url: str) -> bool:
    host = urlparse((url or "").strip()).netloc.lower()
    return any(h in host for h in LOW_QUALITY_HOST_HINTS)


def main() -> None:
    with RESULTS_FILE.open("r", encoding="utf-8") as f:
        results = json.load(f)

    schools = results.get("schools") or {}
    changed = recategorize_short_content_failures(results)
    status_counts = Counter((v or {}).get("status") for v in schools.values())

    school_name_by_id = {}
    if SCHOOLS_FILE.exists():
        with SCHOOLS_FILE.open("r", encoding="utf-8") as f:
            school_rows = json.load(f)
        school_name_by_id = {str(s.get("id")): s.get("name", "") for s in school_rows}

    unresolved_rows = []
    for sid, item in schools.items():
        status = item.get("status")
        if status not in ("failed", "not_found"):
            continue
        ext = item.get("extraction") or {}
        unresolved_rows.append(
            {
                "school_id": sid,
                "school_name": item.get("school_name")
                or school_name_by_id.get(sid, ""),
                "status": status,
                "source": item.get("source") or "",
                "source_url": item.get("source_url") or "",
                "raw_text_length": item.get("raw_text_length") or 0,
                "error": ext.get("error") or item.get("error") or "",
                "notes": ext.get("notes") or "",
                "low_quality_host": "yes"
                if low_quality_host(item.get("source_url") or "")
                else "no",
            }
        )

    unresolved_rows.sort(
        key=lambda x: (
            0 if x["status"] == "failed" else 1,
            -int(x["raw_text_length"] or 0),
        )
    )

    with UNRESOLVED_FILE.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "school_id",
                "school_name",
                "status",
                "source",
                "source_url",
                "raw_text_length",
                "error",
                "notes",
                "low_quality_host",
            ],
        )
        writer.writeheader()
        writer.writerows(unresolved_rows)

    not_found_rows = [r for r in unresolved_rows if r["status"] == "not_found"]
    retry_summary = {
        "timestamp": datetime.now().isoformat(),
        "status": {
            "success": status_counts.get("success", 0),
            "not_found": status_counts.get("not_found", 0),
            "failed": status_counts.get("failed", 0),
        },
        "not_found_samples": [
            {
                "name": r["school_name"],
                "source_url": r["source_url"],
                "raw_text_length": r["raw_text_length"],
            }
            for r in sorted(
                not_found_rows, key=lambda x: -int(x["raw_text_length"] or 0)
            )[:80]
        ],
        "low_quality_not_found_count": sum(
            1 for r in not_found_rows if r["low_quality_host"] == "yes"
        ),
    }

    with RETRY_SUMMARY_FILE.open("w", encoding="utf-8") as f:
        json.dump(retry_summary, f, ensure_ascii=False, indent=2)

    success_found_without_subject = []
    for sid, item in schools.items():
        if item.get("status") != "success":
            continue
        extraction = item.get("extraction") or {}
        if not extraction.get("found"):
            continue
        if has_subject_requirements(extraction):
            continue

        success_found_without_subject.append(
            {
                "school_id": sid,
                "school_name": item.get("school_name")
                or school_name_by_id.get(sid, ""),
                "source_url": item.get("source_url") or "",
                "related_links": item.get("related_links") or [],
                "image_links": item.get("image_links") or [],
                "notes": extraction.get("notes") or "",
                "confidence": extraction.get("confidence") or "",
            }
        )

    followup = {
        "timestamp": datetime.now().isoformat(),
        "status_counts": {
            "success": status_counts.get("success", 0),
            "not_found": status_counts.get("not_found", 0),
            "failed": status_counts.get("failed", 0),
        },
        "success_found_without_subject_count": len(success_found_without_subject),
        "success_found_without_subject": success_found_without_subject,
    }

    with FOLLOWUP_FILE.open("w", encoding="utf-8") as f:
        json.dump(followup, f, ensure_ascii=False, indent=2)

    results["last_updated"] = datetime.now().isoformat()
    with RESULTS_FILE.open("w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(
        json.dumps(
            {
                "changed_failed_to_not_found": changed,
                "status": {
                    "success": status_counts.get("success", 0),
                    "not_found": status_counts.get("not_found", 0),
                    "failed": status_counts.get("failed", 0),
                },
                "unresolved": len(unresolved_rows),
                "low_quality_not_found": retry_summary["low_quality_not_found_count"],
                "success_found_without_subject": len(success_found_without_subject),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
