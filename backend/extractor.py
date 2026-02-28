"""
使用AI提取招生简章中的结构化信息
"""

import httpx
import json
import re
from config import OPENAI_API_BASE, OPENAI_API_KEY, OPENAI_MODEL

EXTRACTION_PROMPT = """你是一个专门提取台湾学测招生信息的助手。请从以下招生简章内容中提取结构化信息。

输出要求（非常重要）：
1. 只输出一个JSON对象（不要Markdown/不要代码块/不要多余文字）
2. JSON必须完整可解析；如果内容很长会导致输出不完整，请主动省略不重要细节以保证JSON完整
3. 不要抄录大段原文；不要输出“专业/招生计划/学院/专业名单”等长列表
4. department_requirements 仅在“不同学院/专业要求不同”时填写；每项只写简短department名称 + 科目要求 + 简短notes（不要列出所有专业名称）
5. 学测科目：国文、英文、数学A、数学B、社会、自然；成绩标准：顶标/前标/均标/后标/底标 或 级分(1-15)
6. 找不到信息则对应字段填null；找不到2026年台湾学测招生信息则 found=false
7. 若出现“任一/任一科/其一/择一/之一/任意/多者其一/其中一/任何一科/任何一”等表述，必须把对应科目直接写进 subjects 或 general_requirements，并在 standard 中用“任一X标”表示（例如“任一均标”）；不要只在 notes 里写“任一”

请以如下JSON结构返回（不要增加字段）：
{
  "found": true,
  "year": 2026,
  "application_deadline": null,
  "general_requirements": {
    "chinese": {"standard": null, "min_score": null},
    "english": {"standard": null, "min_score": null},
    "math_a": {"standard": null, "min_score": null},
    "math_b": {"standard": null, "min_score": null},
    "social": {"standard": null, "min_score": null},
    "science": {"standard": null, "min_score": null}
  },
  "department_requirements": [],
  "other_conditions": [],
  "contact": null,
  "notes": null,
  "confidence": "high"
}

其中 department_requirements 每项结构为：
{
  "department": "学院/专业（简短名称）",
  "subjects": {
    "chinese": {"standard": null, "min_score": null},
    "english": {"standard": null, "min_score": null},
    "math_a": {"standard": null, "min_score": null},
    "math_b": {"standard": null, "min_score": null},
    "social": {"standard": null, "min_score": null},
    "science": {"standard": null, "min_score": null}
  },
  "notes": null
}

如果找不到2026年台湾学测招生信息，返回：
{"found": false, "confidence": "high"}

招生简章内容：
---
{content}
---

请直接返回JSON，不要有其他文字。"""


RETRY_PROMPT = """你刚才的输出不是完整可解析的JSON（可能被截断）。请基于同一份招生简章内容重新提取，并输出更短的、严格可解析的JSON。

额外限制：
1. 只输出JSON对象，不要代码块
2. 不要输出长列表（尤其不要列出专业/学院/招生计划名单）
3. department_requirements 最多10项，notes尽量简短
4. “任一/其一/任何一科”类条件必须展开到对应科目字段，并在 standard 中用“任一X标”表示（例如“任一均标”），不要只写在notes

招生简章内容：
---
{content}
---

请直接返回JSON，不要有其他文字。"""


def extract_json_from_text(text: str) -> str:
    """从文本中提取JSON部分"""
    text = text.strip()

    # 处理markdown代码块
    if "```" in text:
        match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
        if match:
            text = match.group(1).strip()

    # 找到第一个 { 和最后一个 }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]

    return text


def parse_json_with_repair(text: str) -> dict:
    """解析JSON，失败时做轻量修复后重试。"""
    candidates = [text]

    # 常见缺失逗号：前一个字段以 } 或 ] 结尾，下一行直接开始 "key"
    fixed_missing_comma = re.sub(
        r'([}\]])\s*("[A-Za-z_][^"\\]*"\s*:)', r"\1,\n\2", text
    )
    if fixed_missing_comma != text:
        candidates.append(fixed_missing_comma)

    # 常见多余逗号：对象或数组末尾出现 trailing comma
    fixed_trailing_comma = re.sub(r",\s*([}\]])", r"\1", fixed_missing_comma)
    if fixed_trailing_comma not in candidates:
        candidates.append(fixed_trailing_comma)

    last_error = None
    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError as e:
            last_error = e

    raise last_error


async def call_ai_api(messages: list) -> str:
    """调用AI API：优先 chat/completions，失败则尝试 responses"""
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY 未配置")

    base = OPENAI_API_BASE.rstrip("/")
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    def _error_text(resp: httpx.Response) -> str:
        try:
            data = resp.json()
            if isinstance(data, dict):
                err = data.get("error")
                if isinstance(err, dict):
                    msg = err.get("message") or err.get("code")
                    if msg:
                        return str(msg)
                    return json.dumps(err, ensure_ascii=False)
        except Exception:
            pass
        return (resp.text or "")[:500]

    async def _call_chat_completions() -> str:
        payload = {
            "model": OPENAI_MODEL,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 4000,
            "stream": False,  # 明确禁用流式
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{base}/chat/completions", headers=headers, json=payload
            )

        if resp.status_code != 200:
            raise RuntimeError(
                f"chat/completions {resp.status_code}: {_error_text(resp)}"
            )

        # 检查是否是流式响应
        content_type = resp.headers.get("content-type", "")
        text = resp.text

        if "text/event-stream" in content_type or text.startswith("data:"):
            # 解析SSE流式响应
            content_parts = []
            for line in text.split("\n"):
                if line.startswith("data:") and not line.strip() == "data: [DONE]":
                    try:
                        data = json.loads(line[5:].strip())
                        if "choices" in data and data["choices"]:
                            delta = data["choices"][0].get("delta", {})
                            if "content" in delta:
                                content_parts.append(delta["content"])
                    except json.JSONDecodeError:
                        continue
            content = "".join(content_parts)
        else:
            # 标准JSON响应
            data = resp.json()
            content = ""
            if "choices" in data and data["choices"]:
                content = data["choices"][0].get("message", {}).get("content", "")

        if not content:
            raise RuntimeError("chat/completions 返回空内容")
        return content

    async def _call_responses() -> str:
        input_text = "\n\n".join(
            f"{m.get('role', 'user')}: {m.get('content', '')}"
            if isinstance(m, dict)
            else str(m)
            for m in messages
        )
        payload = {
            "model": OPENAI_MODEL,
            "input": input_text,
            "temperature": 0.1,
            "max_output_tokens": 2000,
        }

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f"{base}/responses", headers=headers, json=payload)

        if resp.status_code != 200:
            raise RuntimeError(f"responses {resp.status_code}: {_error_text(resp)}")

        data = resp.json()

        if isinstance(data, dict) and isinstance(data.get("output_text"), str):
            out = data.get("output_text")
            if out:
                return out

        parts = []
        if isinstance(data, dict) and isinstance(data.get("output"), list):
            for item in data.get("output"):
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for c in content:
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") == "output_text" and isinstance(
                        c.get("text"), str
                    ):
                        parts.append(c.get("text"))

        out = "".join(parts).strip()
        if not out:
            raise RuntimeError("responses 返回空内容")
        return out

    errors = []
    for fn in (_call_chat_completions, _call_responses):
        try:
            return await fn()
        except Exception as e:
            errors.append(str(e))

    raise RuntimeError("AI API 调用失败: " + " | ".join(errors))


async def extract_requirements(
    school_name: str, content: str, allow_short: bool = False
) -> dict:
    """使用AI提取招生要求"""
    if not content or (len(content) < 100 and not allow_short):
        return {"found": False, "error": "内容过短或为空", "confidence": "low"}

    # 截断过长内容
    if len(content) > 15000:
        content = content[:15000] + "\n...(内容已截断)"

    try:
        prompt = EXTRACTION_PROMPT.replace("{content}", content)
        messages = [
            {
                "role": "system",
                "content": "你是一个精确的信息提取助手，专门处理大学招生简章。请严格按照要求的JSON格式输出。",
            },
            {"role": "user", "content": prompt},
        ]

        result_text = await call_ai_api(messages)
        print(f"[AI响应] 原始文本前300字符: {result_text[:300]}")

        if not result_text:
            return {"found": False, "error": "AI返回空响应", "confidence": "low"}

        # 提取JSON
        extracted = extract_json_from_text(result_text)
        try:
            result = parse_json_with_repair(extracted)
            result["school_name"] = school_name
            return result
        except json.JSONDecodeError as e:
            print(f"[JSON解析失败] 将重试一次: {e}")
            retry_prompt = RETRY_PROMPT.replace("{content}", content)
            retry_messages = [
                {
                    "role": "system",
                    "content": "你是一个精确的信息提取助手。只输出严格可解析的JSON。",
                },
                {"role": "user", "content": retry_prompt},
            ]
            retry_text = await call_ai_api(retry_messages)
            retry_extracted = extract_json_from_text(retry_text)
            result = parse_json_with_repair(retry_extracted)
            result["school_name"] = school_name
            result["retried"] = True
            return result

    except json.JSONDecodeError as e:
        print(
            f"[JSON解析失败] 原始响应: {result_text[:1000] if 'result_text' in locals() else 'N/A'}"
        )
        return {
            "found": False,
            "error": f"JSON解析失败: {e}",
            "raw_response": result_text[:500] if "result_text" in locals() else None,
            "confidence": "low",
        }
    except Exception as e:
        import traceback

        print(f"[提取异常] {type(e).__name__}: {e}")
        traceback.print_exc()
        return {"found": False, "error": str(e), "confidence": "low"}


async def extract_requirements_from_images(school_name: str, image_urls: list) -> dict:
    """尝试用视觉模型先OCR图片，再结构化提取。"""
    if not image_urls:
        return {"found": False, "error": "无图片可提取", "confidence": "low"}

    if not OPENAI_API_KEY:
        return {"found": False, "error": "OPENAI_API_KEY 未配置", "confidence": "low"}

    base = OPENAI_API_BASE.rstrip("/")
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    prompt = (
        "请识别图片中的文字，只输出与以下内容相关的原文片段："
        "2026年、台湾学测、科目要求（语文/英文/数学A/数学B/社会/自然）、"
        "成绩标准（顶标/前标/均标/后标/底标/级分）、报名截止日期。"
        "不要解释，不要总结，只输出提取到的原文。"
    )

    content = [{"type": "text", "text": prompt}]
    for url in image_urls[:2]:
        content.append({"type": "image_url", "image_url": {"url": url}})

    payload = {
        "model": OPENAI_MODEL,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": 1200,
        "stream": False,
    }

    # 视觉接口容易超时，做重试
    last_error = None
    for _ in range(4):
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                resp = await client.post(
                    f"{base}/chat/completions", headers=headers, json=payload
                )
            if resp.status_code != 200:
                last_error = (
                    f"chat/completions {resp.status_code}: {(resp.text or '')[:200]}"
                )
                continue

            data = resp.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if not text:
                last_error = "视觉模型返回空内容"
                continue

            # 第二步：将OCR文本再走结构化提取
            ocr_text = text.strip()
            if len(ocr_text) < 20:
                last_error = "OCR文本过短"
                continue

            structured = await extract_requirements(
                school_name,
                ocr_text,
                allow_short=True,
            )
            structured["from_image"] = True
            note = structured.get("notes") or ""
            structured["notes"] = (note + " 图片OCR辅助提取").strip()
            return structured
        except Exception as e:
            last_error = str(e)

    return {
        "found": False,
        "error": f"视觉提取失败: {last_error}",
        "confidence": "low",
    }


async def validate_and_enhance(result: dict, school_name: str) -> dict:
    """验证和增强提取结果"""
    result["school_name"] = school_name

    if (
        result.get("found")
        and not result.get("general_requirements")
        and not result.get("department_requirements")
    ):
        result["confidence"] = "low"
        result["notes"] = (result.get("notes", "") + " 未找到具体科目要求").strip()

    return result
