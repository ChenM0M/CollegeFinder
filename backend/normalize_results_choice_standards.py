import json
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RESULTS_FILE = ROOT / "data" / "results.json"


def main() -> None:
    # Import from backend/main.py (same folder) to reuse the exact normalization rules.
    from main import normalize_extraction_structure

    with RESULTS_FILE.open("r", encoding="utf-8") as f:
        results = json.load(f)

    changed_schools = 0
    changed_extractions = 0

    for sid, item in (results.get("schools") or {}).items():
        ext = (item or {}).get("extraction")
        if not isinstance(ext, dict) or not ext.get("found"):
            continue

        before = json.dumps(ext, ensure_ascii=False, sort_keys=True)
        new_ext = normalize_extraction_structure(ext)
        after = json.dumps(new_ext, ensure_ascii=False, sort_keys=True)

        if before != after:
            item["extraction"] = new_ext
            changed_schools += 1

            if "任一" in after and "任一" not in before:
                changed_extractions += 1

    results["last_updated"] = datetime.now().isoformat()
    with RESULTS_FILE.open("w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(
        json.dumps(
            {
                "changed_schools": changed_schools,
                "new_any_standard_extractions": changed_extractions,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
