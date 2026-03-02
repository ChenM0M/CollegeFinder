"""CAC Star (繁星推薦) extraction helpers.

This module extracts structured "錄取標準一覽表" information from CAC history PDFs.
We intentionally keep the output schema compact (flattened subject fields) to
control token usage and make downstream filtering easier.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from extractor import call_ai_api, extract_json_from_text, parse_json_with_repair


STAR_PAGE_PROMPT = """你是一个专门从台湾 CAC「繁星推荐」历史资料的《录取标准一览表》里提取结构化数据的助手。

你将收到：某一年、某校、某一页 PDF 抽出的文字（可能存在乱码、换行混乱、重复表头）。

请严格按要求输出，注意：我们只需要与“考生条件查询”一致的字段：全校排名百分比、学测各科级分/成绩标准、英听等级。

输出要求（非常重要）：
1. 只输出一个 JSON 对象（不要 Markdown/不要代码块/不要解释）
2. JSON 必须完整可解析；如果内容很长导致输出可能超长，请优先保证 JSON 完整，可以少量省略不重要字段（但不要省略 rows 里的关键字段）
3. rows 为数组；每一项表示“一个校系 + 一轮(第1轮/第2轮)的录取标准”
4. 若同一 program_code 在本页出现多次（例如出现「加印/外加」等重复），仍然输出多条 rows，并在 notes 中说明（例如 "加印"）
5. program_name 若从文本中无法可靠识别（乱码/缺失），可填 null
6. school_rank_percent：提取“全校排名百分比”（例如 7% -> 7）。找不到填 null
7. round：只能是 1 或 2。若无法判断轮次，默认 1
8. 科目字段：chinese/english/math_a/math_b/social/science。每科两列：*_std 与 *_score。
   - *_std 只能是：顶标/前标/均标/后标/底标（用简体字输出）或 null
   - *_score 为 1-15 的整数或 null
9. english_listening：英听等级。若为 A/B/C/F 则输出对应大写字母，否则输出原文（字符串）。找不到填 null

请按如下 JSON 结构返回（不要增加字段）：
{
  "found": true,
  "year": {year},
  "school_code": "{school_code}",
  "school_name": "{school_name}",
  "page": {page},
  "rows": [
    {
      "program_code": "00101",
      "program_name": null,
      "quota": null,
      "extra_quota": null,
      "round": 1,
      "school_rank_percent": null,
      "english_listening": null,
      "chinese_std": null,
      "chinese_score": null,
      "english_std": null,
      "english_score": null,
      "math_a_std": null,
      "math_a_score": null,
      "math_b_std": null,
      "math_b_score": null,
      "social_std": null,
      "social_score": null,
      "science_std": null,
      "science_score": null,
      "notes": null
    }
  ],
  "confidence": "high"
}

如果本页没有任何校系数据，请返回：
{"found": false, "confidence": "high", "rows": []}

PDF 页面文字（可能有乱码）：
---
{content}
---

请直接返回 JSON，不要有其他文字。"""


STAR_PAGE_RETRY_PROMPT = """你刚才的输出不是完整可解析的 JSON（可能被截断或含有多余文字）。

请基于同一份 PDF 页面文字重新提取，并输出更短、严格可解析的 JSON。

额外限制：
1. 只输出 JSON 对象，不要代码块
2. rows 不要超过 80 条；如果超过，请只保留 program_code 最小的前 80 条（按 program_code 升序）
3. 不要输出任何额外字段
4. *_std 只能是 顶标/前标/均标/后标/底标（简体）或 null；*_score 为 1-15 整数或 null

PDF 页面文字：
---
{content}
---

请直接返回 JSON，不要有其他文字。"""


def _ensure_int_or_none(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return int(float(s))
        except Exception:
            return None
    return None


def _ensure_float_or_none(v: Any) -> Optional[float]:
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


def _norm_std(v: Any) -> Optional[str]:
    if not isinstance(v, str):
        return None
    s = v.strip()
    if not s:
        return None

    # normalize traditional to simplified for the five standard words
    mapping = {
        "頂標": "顶标",
        "前標": "前标",
        "均標": "均标",
        "後標": "后标",
        "底標": "底标",
        "顶标": "顶标",
        "前标": "前标",
        "均标": "均标",
        "后标": "后标",
        "底标": "底标",
    }
    return mapping.get(s)


def _coerce_row(row: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return None

    out: Dict[str, Any] = {}

    out["program_code"] = str(row.get("program_code") or "").strip() or None
    out["program_name"] = (
        str(row.get("program_name")).strip()
        if isinstance(row.get("program_name"), str)
        else None
    )
    out["quota"] = _ensure_int_or_none(row.get("quota"))
    out["extra_quota"] = _ensure_int_or_none(row.get("extra_quota"))

    r = _ensure_int_or_none(row.get("round"))
    out["round"] = 2 if r == 2 else 1

    out["school_rank_percent"] = _ensure_float_or_none(row.get("school_rank_percent"))

    el = row.get("english_listening")
    if isinstance(el, str) and el.strip():
        out["english_listening"] = el.strip()
    else:
        out["english_listening"] = None

    for k in [
        "chinese",
        "english",
        "math_a",
        "math_b",
        "social",
        "science",
    ]:
        out[f"{k}_std"] = _norm_std(row.get(f"{k}_std"))
        score = _ensure_int_or_none(row.get(f"{k}_score"))
        out[f"{k}_score"] = score if score is not None and 1 <= score <= 15 else None

    out["notes"] = (
        str(row.get("notes")).strip()
        if isinstance(row.get("notes"), str) and row.get("notes").strip()
        else None
    )

    return out


async def extract_star_pdf_page(
    *,
    year: int,
    school_code: str,
    school_name: str,
    page: int,
    content: str,
) -> Dict[str, Any]:
    text = (content or "").strip()
    if len(text) < 20:
        return {
            "found": False,
            "confidence": "low",
            "rows": [],
            "error": "页面文本过短",
        }

    # Truncate extremely long pages to keep outputs stable.
    if len(text) > 22000:
        text = text[:22000] + "\n...(内容已截断)"

    prompt = STAR_PAGE_PROMPT.format(
        year=int(year),
        school_code=str(school_code),
        school_name=str(school_name),
        page=int(page),
        content=text,
    )

    messages = [
        {
            "role": "system",
            "content": "你是一个精确的信息提取助手，擅长从混乱文本中提取表格结构，并严格输出可解析JSON。",
        },
        {"role": "user", "content": prompt},
    ]

    result_text = await call_ai_api(messages)
    extracted = extract_json_from_text(result_text or "")

    try:
        obj = parse_json_with_repair(extracted)
    except json.JSONDecodeError:
        retry_prompt = STAR_PAGE_RETRY_PROMPT.format(content=text)
        retry_messages = [
            {
                "role": "system",
                "content": "你是一个精确的信息提取助手。只输出严格可解析的JSON。",
            },
            {"role": "user", "content": retry_prompt},
        ]
        retry_text = await call_ai_api(retry_messages)
        retry_extracted = extract_json_from_text(retry_text or "")
        obj = parse_json_with_repair(retry_extracted)
        if isinstance(obj, dict):
            obj["retried"] = True

    if not isinstance(obj, dict):
        return {
            "found": False,
            "confidence": "low",
            "rows": [],
            "error": "AI输出结构异常",
        }

    found = bool(obj.get("found"))
    rows = obj.get("rows")
    if not isinstance(rows, list):
        rows = []

    cleaned_rows = []
    for r in rows:
        cr = _coerce_row(r)
        if not cr:
            continue
        # Must have program_code
        pc = cr.get("program_code")
        if not isinstance(pc, str) or not pc.strip():
            continue
        cleaned_rows.append(cr)

    out: Dict[str, Any] = {
        "found": found and bool(cleaned_rows),
        "year": int(year),
        "school_code": str(school_code),
        "school_name": str(school_name),
        "page": int(page),
        "rows": cleaned_rows,
        "confidence": str(obj.get("confidence") or "medium"),
    }

    if isinstance(obj.get("error"), str) and obj.get("error"):
        out["error"] = obj.get("error")

    if obj.get("retried"):
        out["retried"] = True

    return out
