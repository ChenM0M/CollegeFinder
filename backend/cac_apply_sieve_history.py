"""Extract Apply (申請入學) historical sieve cutoffs from CAC PNG reports.

CAC provides historical "各校系篩選標準一覽表" as per-school PNG images:
  /cacportal/apply_his_report/{year}/{year}_sieve_standard/report/pict/{school}.png

Those images contain (for each apply program code) the "通過倍率篩選最低級分(分數)" columns
under 篩選順序一..六, plus a flag column (同級分超額篩選: '*').

We use Windows built-in OCR (winsdk) to get word-level bounding boxes, then read values by
table column x-ranges.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

import cv2
import numpy as np
from bs4 import BeautifulSoup


CAC_BASE = "https://www.cac.edu.tw"

SIEVE_LIST_URL_TMPL = (
    CAC_BASE
    + "/cacportal/apply_his_report/{year}/{year}_sieve_standard/collegeList.htm"
)
SIEVE_IMAGE_URL_TMPL = (
    CAC_BASE
    + "/cacportal/apply_his_report/{year}/{year}_sieve_standard/report/pict/{school_code}.png"
)


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
}


@dataclass
class OcrWord:
    text: str
    x: float
    y: float
    w: float
    h: float

    @property
    def x0(self) -> float:
        return float(self.x)

    @property
    def x1(self) -> float:
        return float(self.x + self.w)

    @property
    def y0(self) -> float:
        return float(self.y)

    @property
    def y1(self) -> float:
        return float(self.y + self.h)

    @property
    def xc(self) -> float:
        return float(self.x + self.w / 2.0)

    @property
    def yc(self) -> float:
        return float(self.y + self.h / 2.0)


def _ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def parse_school_codes_from_college_list(
    html: str, base_url: str
) -> List[Tuple[str, str]]:
    """Return list of (school_code, image_url)."""
    soup = BeautifulSoup(html or "", "lxml")
    out: List[Tuple[str, str]] = []
    for a in soup.find_all("a", href=True):
        href = (a.get("href") or "").strip()
        m = re.search(r"report/(\d{3})\.htm", href)
        if not m:
            continue
        school_code = m.group(1)
        img_url = SIEVE_IMAGE_URL_TMPL.format(
            year=int(_year_from_url(base_url)), school_code=school_code
        )
        # Prefer urljoin to be safe if template changes
        if "report/pict/" not in img_url:
            img_url = urljoin(base_url, f"report/pict/{school_code}.png")
        out.append((school_code, img_url))

    # Deduplicate while keeping order
    seen = set()
    uniq = []
    for sc, u in out:
        if sc in seen:
            continue
        seen.add(sc)
        uniq.append((sc, u))
    return uniq


def _year_from_url(url: str) -> int:
    m = re.search(r"/apply_his_report/(\d{3})/", url or "")
    if m:
        return int(m.group(1))
    return 0


def detect_right_columns_from_image_bytes(image_bytes: bytes) -> List[int]:
    """Detect the right-side column boundaries for order1..6 + flag.

    Returns 8 x-positions (ascending) forming 7 segments:
      [order1|order2|order3|order4|order5|order6|flag]
    """
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError("无法解码 PNG")

    h, w = img.shape[:2]
    # Use relative crop so it also works for resized images.
    y0 = max(0, int(h * 0.04))
    y1 = min(h, int(h * 0.12))
    if (y1 - y0) < 120:
        y1 = min(h, y0 + 240)
    crop = img[y0:y1, :]
    if crop.size == 0:
        raise RuntimeError("PNG header crop 为空")

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    bw = cv2.adaptiveThreshold(
        ~gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 15, -2
    )

    vertical = bw.copy()
    vertical_size = max(10, vertical.shape[0] // 2)
    vertical_structure = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_size))
    vertical = cv2.erode(vertical, vertical_structure)
    vertical = cv2.dilate(vertical, vertical_structure)

    proj = vertical.sum(axis=0)
    if proj.max() <= 0:
        raise RuntimeError("无法检测表格竖线")
    thr = float(proj.max()) * 0.5
    xs = np.where(proj > thr)[0]
    if xs.size == 0:
        raise RuntimeError("无法检测表格竖线(空)")

    groups = []
    start = int(xs[0])
    prev = int(xs[0])
    for x in xs[1:]:
        x = int(x)
        if x == prev + 1:
            prev = x
            continue
        groups.append((start, prev))
        start = x
        prev = x
    groups.append((start, prev))
    centers = [int((a + b) // 2) for a, b in groups]
    centers.sort()

    if len(centers) < 8:
        raise RuntimeError(f"竖线数量不足: {len(centers)}")

    # Rightmost 8 lines correspond to the 6 order columns + flag + right border
    right = centers[-8:]
    right.sort()
    return right


async def ocr_words_windows(
    image_bytes: bytes, *, lang_tag: str = "zh-Hans-CN"
) -> List[OcrWord]:
    """OCR image to word boxes using Windows OCR (winsdk).

    This requires Windows + the `winsdk` Python package.
    """
    try:
        from winsdk.windows.media.ocr import OcrEngine
        from winsdk.windows.globalization import Language
        from winsdk.windows.storage.streams import (
            InMemoryRandomAccessStream,
            DataWriter,
        )
        from winsdk.windows.graphics.imaging import BitmapDecoder
    except Exception as e:
        raise RuntimeError("缺少 Windows OCR 依赖（winsdk）") from e

    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream)
    writer.write_bytes(image_bytes)
    await writer.store_async()
    await writer.flush_async()
    writer.detach_stream()
    stream.seek(0)

    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()

    engine = OcrEngine.try_create_from_language(Language(lang_tag))
    if engine is None:
        engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("Windows OCR 引擎不可用")

    result = await engine.recognize_async(bitmap)

    out: List[OcrWord] = []
    for line in list(result.lines):
        for w in list(line.words):
            rect = w.bounding_rect
            out.append(
                OcrWord(
                    text=str(w.text or ""),
                    x=float(rect.x),
                    y=float(rect.y),
                    w=float(rect.width),
                    h=float(rect.height),
                )
            )
    return out


def _join_cell_words(words: List[OcrWord]) -> str:
    if not words:
        return ""
    words2 = sorted(words, key=lambda w: (w.y0, w.x0))
    s = "".join([w.text for w in words2])
    s = re.sub(r"\s+", "", s)
    return s.strip()


def extract_sieve_rows_from_words(
    words: List[OcrWord],
    *,
    right_cols: List[int],
    row_y_tol: float = 14.0,
    code_words: Optional[List[OcrWord]] = None,
) -> Dict[str, Dict[str, Any]]:
    """Extract per-program sieve cutoffs.

    Returns: apply_code -> { min_orders: [{expr,min_score,raw,order}], oversubscribe }
    """
    if not words:
        return {}
    if not right_cols or len(right_cols) != 8:
        raise ValueError("right_cols must have 8 boundaries")

    code_pat = re.compile(r"^\d{6}$")
    base_words = code_words if isinstance(code_words, list) and code_words else words
    code_words2 = [w for w in base_words if code_pat.match((w.text or "").strip())]
    # Prefer codes in left side
    left_limit = float(right_cols[0])
    code_words2 = [w for w in code_words2 if w.x0 < left_limit]
    if not code_words2:
        return {}

    # Deduplicate codes by picking the top-most occurrence with smallest x
    best: Dict[str, OcrWord] = {}
    for w in sorted(code_words2, key=lambda ww: (ww.y0, ww.x0)):
        t = (w.text or "").strip()
        if t not in best:
            best[t] = w
        else:
            cur = best[t]
            if w.y0 < cur.y0 - 3 or (abs(w.y0 - cur.y0) <= 3 and w.x0 < cur.x0):
                best[t] = w

    out: Dict[str, Dict[str, Any]] = {}
    for code, cw in best.items():
        yc = cw.yc
        band0 = yc - float(row_y_tol)
        band1 = yc + float(row_y_tol)

        row_words = [w for w in words if band0 <= w.yc <= band1]
        if not row_words:
            continue

        min_orders = []
        # order1..6
        for idx in range(6):
            x0 = float(right_cols[idx])
            x1 = float(right_cols[idx + 1])
            cell_words = [w for w in row_words if x0 <= w.xc < x1]
            raw = _join_cell_words(cell_words)
            raw = raw.replace("—", "-")
            if not raw or raw in ("-", "--"):
                continue
            if raw == "*":
                continue

            # Prefer the last number anywhere (OCR may add trailing '+'/'÷', or miss separators)
            m_last = None
            for m in re.finditer(r"(\d{1,3})", raw):
                m_last = m

            if m_last is not None:
                n = int(m_last.group(1))
                expr = raw[: m_last.start()]
            else:
                # Common OCR confusion: '15' -> '巧'/'用'
                tail = raw[-1:]
                if tail in ("巧", "用"):
                    n = 15
                    expr = raw[:-1]
                else:
                    continue

            expr = expr.strip()
            expr = expr.replace("（", "(").replace("）", ")")
            if expr:
                min_orders.append(
                    {
                        "order": idx + 1,
                        "expr": expr,
                        "min_score": n,
                        "raw": raw,
                    }
                )

        # oversubscribe flag column
        fx0 = float(right_cols[6])
        fx1 = float(right_cols[7])
        flag_raw = _join_cell_words([w for w in row_words if fx0 <= w.xc < fx1])
        oversub = "*" in (flag_raw or "")

        cur = out.get(code)
        score_cur = len(cur.get("min_orders") or []) if isinstance(cur, dict) else -1
        score_new = len(min_orders)
        if cur is None or score_new > score_cur:
            out[code] = {
                "apply_code": code,
                "min_orders": min_orders,
                "oversubscribe": bool(oversub),
            }

    return out


def merge_year_maps(
    year_maps: Dict[str, Dict[str, Any]],
    new_map: Dict[str, Dict[str, Any]],
    *,
    year: int,
    school_code: str,
    source_image: str,
):
    for code, ent in (new_map or {}).items():
        if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
            continue
        ent2 = dict(ent)
        ent2["year"] = int(year)
        ent2["school_code"] = str(school_code)
        ent2["source_image"] = str(source_image)
        # Pick the one with more orders
        cur = year_maps.get(code)
        cur_n = (
            len((cur or {}).get("min_orders") or []) if isinstance(cur, dict) else -1
        )
        new_n = len(ent2.get("min_orders") or [])
        if cur is None or new_n > cur_n:
            year_maps[code] = ent2


def now_iso() -> str:
    return datetime.now().isoformat()
