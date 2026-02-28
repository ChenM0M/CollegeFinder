"""测试 OpenAI兼容API（models/chat/responses）"""

import asyncio
import json
import os

import httpx
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

OPENAI_API_BASE = (os.getenv("OPENAI_API_BASE") or "").rstrip("/")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") or ""
OPENAI_MODEL = os.getenv("OPENAI_MODEL") or ""

print(f"API Base: {OPENAI_API_BASE}")
print(f"Model: {OPENAI_MODEL}")


async def test():
    if not OPENAI_API_BASE:
        print("错误: OPENAI_API_BASE 未配置")
        return
    if not OPENAI_API_KEY:
        print("错误: OPENAI_API_KEY 未配置")
        return
    if not OPENAI_MODEL:
        print("错误: OPENAI_MODEL 未配置")
        return

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=120) as client:
        # models
        r = await client.get(f"{OPENAI_API_BASE}/models", headers=headers)
        print(f"\nGET /models: {r.status_code}")
        if r.status_code == 200:
            data = r.json()
            ids = [m.get("id") for m in data.get("data", []) if isinstance(m, dict)]
            print("Available models:", ", ".join([i for i in ids if i]))
        else:
            print(r.text[:500])

        # chat
        chat_payload = {
            "model": OPENAI_MODEL,
            "messages": [
                {"role": "system", "content": "你是一个只输出JSON的助手。"},
                {
                    "role": "user",
                    "content": '请只输出严格JSON对象，不要代码块，不要额外文字：{"test": true}',
                },
            ],
            "temperature": 0.1,
            "max_tokens": 4000,
            "stream": False,
        }
        r = await client.post(
            f"{OPENAI_API_BASE}/chat/completions", headers=headers, json=chat_payload
        )
        print(f"\nPOST /chat/completions: {r.status_code}")
        if r.status_code == 200:
            content_type = (r.headers.get("content-type") or "").lower()
            text = r.text or ""
            content = ""
            if "text/event-stream" in content_type or text.startswith("data:"):
                parts = []
                for line in text.splitlines():
                    if not line.startswith("data:"):
                        continue
                    if line.strip() == "data: [DONE]":
                        continue
                    try:
                        data = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    choices = data.get("choices")
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    if isinstance(delta, dict) and isinstance(
                        delta.get("content"), str
                    ):
                        parts.append(delta.get("content"))
                content = "".join(parts)
            else:
                data = r.json()
                choices = data.get("choices")
                if choices:
                    content = choices[0].get("message", {}).get("content", "")

            print("Content:", content)
        else:
            print(r.text[:800])

        # responses
        resp_payload = {
            "model": OPENAI_MODEL,
            "input": '请只输出严格JSON对象，不要代码块，不要额外文字：{"test": true}',
            "temperature": 0.1,
            "max_output_tokens": 100,
        }
        r = await client.post(
            f"{OPENAI_API_BASE}/responses", headers=headers, json=resp_payload
        )
        print(f"\nPOST /responses: {r.status_code}")
        print(r.text[:800])


asyncio.run(test())
