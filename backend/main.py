"""
CollegeFinder 后端API
"""

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional
import asyncio
import httpx
import json
import os
import re
from datetime import datetime
from urllib.parse import urlparse

from config import DATA_DIR, SCHOOLS_FILE, RESULTS_FILE, CONCURRENCY, REQUEST_DELAY_MS
from fetcher import (
    fetch_school_list,
    fetch_page_content,
    search_fallback,
    fetch_related_content,
    HEADERS,
)
from extractor import (
    extract_requirements,
    extract_requirements_from_images,
    validate_and_enhance,
)
from school_classification import classify_school, is_taiwan_recognized
from apply_classification import (
    ONLINE_SOURCES,
    apply_to_results,
    apply_to_schools,
    build_online_sets,
)

app = FastAPI(title="CollegeFinder API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_frontend_cache(request, call_next):
    response = await call_next(request)
    path = request.url.path or ""
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = (
            "no-store, no-cache, must-revalidate, max-age=0"
        )
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    elif (
        path in ("/", "/index.html", "/summary", "/summary.html")
        or path.endswith(".js")
        or path.endswith(".html")
    ):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# 确保数据目录存在
os.makedirs(DATA_DIR, exist_ok=True)

# 任务状态
task_status = {
    "running": False,
    "current_school": None,
    "progress": 0,
    "total": 0,
    "completed": [],
    "failed": [],
    "start_time": None,
}


class TaskRequest(BaseModel):
    school_ids: Optional[list] = None  # 指定学校ID，为空则处理全部
    use_search_fallback: bool = True  # 是否使用搜索引擎fallback
    force_refresh: bool = False  # 是否强制刷新已有结果


SUBJECT_KEYS = ["chinese", "english", "math_a", "math_b", "social", "science"]
STANDARD_WORDS = ["顶标", "前标", "均标", "后标", "底标"]
CHOICE_WORDS = [
    "任一",
    "任一科",
    "任一门",
    "任一門",
    "任一项",
    "任一項",
    "其一",
    "择一",
    "擇一",
    "之一",
    "任意",
    "多者其一",
    "其中一",
    "任何一",
    "任何一科",
    "任何一门",
    "任何一門",
    "任何一项",
    "任何一項",
]
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
        sub = row.get("subjects") or {}
        if not isinstance(sub, dict):
            continue
        for k in SUBJECT_KEYS:
            v = sub.get(k) or {}
            if v.get("standard") or v.get("min_score"):
                return True

    return False


def heuristic_fill_requirements(extraction: dict, text: str) -> dict:
    """当AI未抽出科目要求时，使用规则从正文中兜底提取。"""
    if not isinstance(extraction, dict):
        return extraction

    raw = text or ""
    if not raw:
        return extraction

    cleaned = raw.replace("（", "(").replace("）", ")")
    cleaned = re.sub(r"\s+", "", cleaned)

    # 初始化 general_requirements 结构
    gen = extraction.get("general_requirements") or {}
    for k in SUBJECT_KEYS:
        gen.setdefault(k, {"standard": None, "min_score": None})

    subject_map = {
        "语文": "chinese",
        "国文": "chinese",
        "英文": "english",
        "英语": "english",
        "数学A": "math_a",
        "數學A": "math_a",
        "数学B": "math_b",
        "數學B": "math_b",
        "社会": "social",
        "社會": "social",
        "自然": "science",
    }

    had_before = has_subject_requirements(extraction)

    # 规则1："语文、英语达到前标" 这类
    pattern = re.compile(
        r"(语文|国文|英文|英语|数学A|數學A|数学B|數學B|社会|社會|自然)([、,，和及与與](语文|国文|英文|英语|数学A|數學A|数学B|數學B|社会|社會|自然))*达到(顶标|前标|均标|后标|底标)"
    )
    for m in pattern.finditer(cleaned):
        phrase = m.group(0)
        std = None
        for s in STANDARD_WORDS:
            if s in phrase:
                std = s
                break
        if not std:
            continue
        for zh, key in subject_map.items():
            if zh in phrase:
                gen[key] = {"standard": std, "min_score": None}

    # 规则1.5："语文/英文/数学A/B 任一(其一/任何一科) 达到均标" 这类
    choice_pattern = re.compile(
        r"((语文|国文|英文|英语|数学A|數學A|数学B|數學B|数学|數學|社会|社會|自然|四科|四门|四項|四项|四科目)[^。；;]{0,40}?)(任一科|任一門|任一门|任一項|任一项|任一|其一|择一|擇一|之一|任意|多者其一|其中一|任何一科|任何一門|任何一门|任何一項|任何一项|任何一)[^。；;]{0,20}?(顶标|前标|均标|后标|底标)"
    )
    for m in choice_pattern.finditer(cleaned):
        phrase = m.group(0)
        std = m.group(4)
        any_std = f"任一{std}" if std else std
        keys = detect_subject_keys(phrase)
        keys = expand_choice_subject_keys(phrase, keys)
        for k in keys:
            cur = gen.get(k) or {"standard": None, "min_score": None}
            cur_std = cur.get("standard")
            if not cur_std:
                cur["standard"] = any_std
            elif isinstance(cur_std, str) and std and cur_std.strip() == std:
                cur["standard"] = any_std
            gen[k] = cur

    # 规则1.6：已写“任一/其一”但仅落了部分科目时，按文本补齐目标科目
    fill_choice_subjects_from_context(gen, cleaned)

    # 规则2："X级分" 或 "X级(含)以上"
    score_patterns = [
        re.compile(
            r"(语文|国文|英文|英语|数学A|數學A|数学B|數學B|社会|社會|自然)[:：]?([0-9]{1,2})级分"
        ),
        re.compile(
            r"(语文|国文|英文|英语|数学A|數學A|数学B|數學B|社会|社會|自然).*?([0-9]{1,2})级"
        ),
    ]
    for sp in score_patterns:
        for m in sp.finditer(cleaned):
            key = subject_map.get(m.group(1))
            if not key:
                continue
            score = int(m.group(2))
            if 1 <= score <= 15:
                cur = gen.get(key) or {"standard": None, "min_score": None}
                cur["min_score"] = score
                gen[key] = cur

    extraction["general_requirements"] = gen

    if has_subject_requirements(extraction) and not had_before:
        note = extraction.get("notes") or ""
        tail = "（由规则兜底从正文识别科目要求）"
        if tail not in note:
            extraction["notes"] = (note + " " + tail).strip()

    return extraction


def detect_subject_keys(text: str) -> list:
    t = (text or "").replace("（", "(").replace("）", ")")
    keys = []

    # 数学A/B并列写法（如 数学A/B、数学A或B）
    if re.search(r"(数学|數學)\s*[AaＡ].{0,4}[/、,，及和與与或].{0,4}[BbＢ]", t):
        keys.extend(["math_a", "math_b"])

    if any(x in t for x in ["语文", "國文", "国文"]):
        keys.append("chinese")
    if any(x in t for x in ["英语", "英文"]):
        keys.append("english")
    if any(x in t for x in ["数学A", "數學A"]):
        keys.append("math_a")
    if any(x in t for x in ["数学B", "數學B"]):
        keys.append("math_b")
    # 仅写“数学”时，通常表示数学(A/B均可或未区分)
    if "数学" in t and "math_a" not in keys and "math_b" not in keys:
        keys.extend(["math_a", "math_b"])
    if any(x in t for x in ["社会", "社會"]):
        keys.append("social")
    if "自然" in t:
        keys.append("science")
    return list(dict.fromkeys(keys))


def has_choice_expression(text: str) -> bool:
    t = text or ""
    return any(w in t for w in CHOICE_WORDS)


def expand_choice_subject_keys(text: str, keys: list) -> list:
    t = (text or "").replace("（", "(").replace("）", ")")
    out = list(dict.fromkeys(keys or []))
    if not has_choice_expression(t):
        return out

    # 常见“四科任一”：默认对应 语文/英文/数学A/数学B
    if any(x in t for x in ["四科", "四门", "四項", "四项", "四科目"]):
        for k in ["chinese", "english", "math_a", "math_b"]:
            if k not in out:
                out.append(k)

    # 数学A/B写作并列时保证两科都命中
    if re.search(r"(数学|數學)\s*[AaＡ].{0,4}[/、,，及和與与或].{0,4}[BbＢ]", t):
        if "math_a" not in out:
            out.append("math_a")
        if "math_b" not in out:
            out.append("math_b")

    return list(dict.fromkeys(out))


def ensure_subjects_shape(subjects: dict) -> dict:
    normalized = subjects if isinstance(subjects, dict) else {}
    for k in SUBJECT_KEYS:
        v = normalized.get(k)
        if not isinstance(v, dict):
            normalized[k] = {"standard": None, "min_score": None}
        else:
            normalized[k] = {
                "standard": v.get("standard"),
                "min_score": v.get("min_score"),
            }
    return normalized


def first_subject_standard(subjects: dict) -> Optional[str]:
    for k in SUBJECT_KEYS:
        v = subjects.get(k) or {}
        std = v.get("standard")
        if std:
            return std
    return None


def fill_choice_subjects_from_context(subjects: dict, context_text: str):
    """将“任一/其一”类条件写入对应科目，而不是只留在备注里。"""
    if not isinstance(subjects, dict):
        return

    context = context_text or ""
    cleaned = re.sub(r"\s+", "", context)

    # 优先从“...任一/任何一科...X标”这类片段中精确识别参与科目
    choice_pattern = re.compile(
        r"((语文|国文|英文|英语|数学A|數學A|数学B|數學B|数学|數學|社会|社會|自然|四科|四门|四項|四项|四科目)[^。；;]{0,40}?)(任一科|任一門|任一门|任一項|任一项|任一|其一|择一|擇一|之一|任意|多者其一|其中一|任何一科|任何一門|任何一门|任何一項|任何一项|任何一)[^。；;]{0,20}?(顶标|前标|均标|后标|底标)"
    )

    applied = False
    for m in choice_pattern.finditer(cleaned):
        phrase = m.group(0)
        std = m.group(4)
        if not std:
            continue
        any_std = f"任一{std}"

        keys = detect_subject_keys(phrase)
        keys = expand_choice_subject_keys(phrase, keys)
        if not keys:
            continue

        for k in keys:
            cur = subjects.get(k) or {"standard": None, "min_score": None}
            cur_std = cur.get("standard")
            if not cur_std:
                cur["standard"] = any_std
            elif isinstance(cur_std, str):
                cur_std_s = cur_std.strip()
                if cur_std_s == std:
                    cur["standard"] = any_std
            subjects[k] = cur
            applied = True

    if not applied:
        keys = detect_subject_keys(context)
        keys = expand_choice_subject_keys(context, keys)
        if not keys:
            return

        std = detect_standard(context) or first_subject_standard(subjects)
        if std and has_choice_expression(context):
            std_s = std.strip() if isinstance(std, str) else str(std)
            base_std = std_s[2:] if std_s.startswith("任一") else std_s
            any_std = std_s if std_s.startswith("任一") else f"任一{std_s}"
            for k in keys:
                cur = subjects.get(k) or {"standard": None, "min_score": None}
                cur_std = cur.get("standard")
                if not cur_std:
                    cur["standard"] = any_std
                elif isinstance(cur_std, str):
                    cur_std_s = cur_std.strip()
                    if cur_std_s == base_std:
                        cur["standard"] = any_std
                subjects[k] = cur

    # 数学A/B任选场景，若只落一科则补齐另一科
    if re.search(
        r"(数学|數學)\s*[AaＡ].{0,4}[/、,，及和與与或].{0,4}[BbＢ]", context
    ) and has_choice_expression(context):
        ma = (subjects.get("math_a") or {}).get("standard")
        mb = (subjects.get("math_b") or {}).get("standard")
        if ma and not mb:
            subjects["math_b"] = {"standard": ma, "min_score": None}
        elif mb and not ma:
            subjects["math_a"] = {"standard": mb, "min_score": None}


def detect_standard(text: str) -> Optional[str]:
    t = text or ""

    mapping = {
        "顶标": ["顶标", "頂標", "����"],
        "前标": ["前标", "前標", "ǰ��"],
        "均标": ["均标", "均標", "����"],
        "后标": ["后标", "後標", "���"],
        "底标": ["底标", "底標", "�ױ�"],
    }

    for std, aliases in mapping.items():
        if any(a in t for a in aliases):
            return std

    return None


def normalize_extraction_structure(extraction: dict) -> dict:
    """清洗AI返回结构，避免异常类型导致后续处理报错。"""
    if not isinstance(extraction, dict):
        return {
            "found": False,
            "error": "提取结构异常",
            "confidence": "low",
            "general_requirements": {},
            "department_requirements": [],
        }

    if not isinstance(extraction.get("general_requirements"), dict):
        extraction["general_requirements"] = {}

    extraction["general_requirements"] = ensure_subjects_shape(
        extraction.get("general_requirements") or {}
    )
    # 修正“任一/其一”只写在备注中的场景
    ext_context_parts = [str(extraction.get("notes") or "")]
    for c in extraction.get("other_conditions") or []:
        if isinstance(c, str):
            ext_context_parts.append(c)
    fill_choice_subjects_from_context(
        extraction["general_requirements"], " ".join(ext_context_parts)
    )

    depts = extraction.get("department_requirements")
    if not isinstance(depts, list):
        extraction["department_requirements"] = []
    else:
        cleaned = []
        for row in depts:
            if not isinstance(row, dict):
                continue

            row_context_parts = [
                str(row.get("subjects") or ""),
                str(row.get("level") or ""),
                str(row.get("notes") or ""),
                str(row.get("standard") or ""),
            ]
            for extra_key in ["math_requirement", "other_requirement", "requirement"]:
                extra_val = row.get(extra_key)
                if isinstance(extra_val, str):
                    row_context_parts.append(extra_val)
            row_context = " ".join(row_context_parts)

            sub = row.get("subjects")
            if isinstance(sub, str):
                keys = detect_subject_keys(row_context)
                keys = expand_choice_subject_keys(row_context, keys)
                std = detect_standard(row_context)
                any_std = std
                if std and has_choice_expression(row_context) and isinstance(std, str):
                    any_std = f"任一{std.strip()}"
                row_sub = ensure_subjects_shape({})
                for k in keys:
                    row_sub[k] = {"standard": any_std, "min_score": None}

                # 兼容 math_requirement / other_requirement 这类非标准字段
                for extra_key in [
                    "math_requirement",
                    "other_requirement",
                    "requirement",
                ]:
                    extra_val = row.get(extra_key)
                    if isinstance(extra_val, str):
                        ekeys = detect_subject_keys(extra_val)
                        ekeys = expand_choice_subject_keys(extra_val, ekeys)
                        estd = detect_standard(extra_val) or std
                        any_estd = estd
                        if (
                            estd
                            and has_choice_expression(extra_val)
                            and isinstance(estd, str)
                        ):
                            any_estd = f"任一{estd.strip()}"
                        for k in ekeys:
                            row_sub[k] = {"standard": any_estd, "min_score": None}

                fill_choice_subjects_from_context(row_sub, row_context)
                row["subjects"] = row_sub
                row["notes"] = row.get("notes") or row.get("level")
            elif isinstance(sub, dict):
                row_sub = ensure_subjects_shape(sub)
                fill_choice_subjects_from_context(row_sub, row_context)
                row["subjects"] = row_sub
            else:
                row_sub = ensure_subjects_shape({})
                fill_choice_subjects_from_context(row_sub, row_context)
                row["subjects"] = row_sub
            cleaned.append(row)
        extraction["department_requirements"] = cleaned

    return extraction


def _norm_parens(s: str) -> str:
    return (s or "").replace("（", "(").replace("）", ")")


def _normalize_major_name(name: str) -> str:
    s = _norm_parens(str(name or "")).strip()
    s = re.sub(r"\s+", "", s)
    s = s.strip(" \t\r\n,;，；。．.·•★☆-—–")
    # 去掉常见的专业代码前缀（如 130203作曲与作曲技术理论）
    s = re.sub(r"^[0-9]{4,12}", "", s)
    s = s.strip(" \t\r\n,;，；。．.·•★☆-—–")

    # 去掉“XX学院/学部”等前缀残留（如 管理学院行政管理 -> 行政管理）
    for sep in [
        "学院",
        "學院",
        "学部",
        "學部",
        "院系",
        "院（系）",
        "院(系)",
    ]:
        if sep in s:
            tail = (s.split(sep)[-1] or "").strip()
            if 2 <= len(tail) <= 40:
                s = tail
                break

    return s


def _is_probable_major_name(name: str) -> bool:
    s = _normalize_major_name(name)
    if not s:
        return False
    if len(s) < 2 or len(s) > 60:
        return False

    # 必须包含一定量的中文字符（避免 AI / A / 2026 等）
    zh_count = sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff")
    if zh_count < 2:
        return False

    # 过短碎片过滤：2字词常见于 HTML 被拆成多个 span
    # 仍保留常见的两字专业/方向/语种（如 法学/日语/音乐/绘画 等）
    if len(s) == 2 and not (s.endswith("学") or s.endswith("语")):
        allow2 = {
            "音乐",
            "舞蹈",
            "绘画",
            "摄影",
            "动画",
            "雕塑",
            "书法",
            "表演",
            "戏剧",
            "美术",
            "体育",
            "翻译",
            "播音",
            "编导",
            "导演",
        }
        if s not in allow2:
            return False

    # URL / 邮箱 / 链接残留
    if re.search(r"https?://|www\.|@", s, re.I):
        return False

    # 数字/金额/编号（专业名一般不包含数字）
    if re.search(r"[0-9]", s):
        return False
    if re.search(r"元", s):
        return False

    # 常见“人数/名额”尾巴（如 武生4名）
    if re.search(r"(名|人|位|条|條|项|項)$", s) and re.search(r"[0-9]", name or ""):
        return False

    # 明显不是专业名的通用字段/导航/材料项
    bad_contains = [
        "首页",
        "返回",
        "当前位置",
        "友情链接",
        "版权所有",
        "技术支持",
        "点击",
        "查看",
        "更多",
        "上页",
        "下页",
        "尾页",
        "通知",
        "公告",
        "快讯",
        "新闻",
        "政策",
        "下载",
        "附件",
        "简章",
        "簡章",
        "指南",
        "指引",
        "须知",
        "須知",
        "规定",
        "規定",
        "办法",
        "辦法",
        "流程",
        "时间",
        "日期",
        "费用",
        "收费",
        "学费",
        "住宿",
        "地址",
        "电话",
        "传真",
        "邮箱",
        "网址",
        "邮编",
        "工作日",
        "入校",
        "入学",
        "入學",
        "招生",
        "招收",
        "报考",
        "報考",
        "填报",
        "网报",
        "網報",
        "保送",
        "教务",
        "教務",
        "外事",
        "參考",
        "参考",
        "掌握",
        "具备",
        "具備",
        "具有",
        "要求",
        "请",
        "請",
        "报名",
        "報名",
        "申请",
        "申請",
        "材料",
        "上传",
        "上傳",
        "提交",
        "填写",
        "填報",
        "登录",
        "登錄",
        "审核",
        "審核",
        "初审",
        "复核",
        "更正",
        "补充",
        "录取",
        "錄取",
        "确认",
        "確認",
        "公示",
        "名单",
        "名單",
        "成绩",
        "成績",
        "学测",
        "學測",
        "面试",
        "面試",
        "体检",
        "體檢",
        "身份证",
        "身份證",
        "居住证",
        "居住證",
        "通行证",
        "通行證",
        "照片",
        "影印",
        "复印",
        "扫描",
        "原件",
        "复印件",
        "电子版",
        "学校",
        "大学",
        "大學",
        "中学",
        "中學",
        "小学",
        "小學",
        "高中",
        "学院",
        "學院",
        "院系",
        "学部",
        "學部",
        "校区",
        "校區",
        "招生网",
        "招生網",
        # 典型“说明句”痕迹
        "所有专业",
        "所有專業",
        "不编制",
        "不編制",
        "分省",
        "分省",
        "须达",
        "須達",
        "不得",
        "不得参加",
        "严禁",
        "嚴禁",
        "未经允许",
        "未經允許",
        "版权",
        "版權",
        "是中国",
        "是中國",
        "保障系统",
        "保障系統",
    ]
    if any(b in s for b in bad_contains):
        return False

    # 含明显句子标点，多半不是专业名
    if any(p in s for p in ["。", "！", "!", "？", "?", "；", ";", "：", ":"]):
        return False

    base = s.split("(", 1)[0].strip()

    # 排除学测科目名称（容易误识别为专业）
    subject_bases = {
        "国文",
        "國文",
        "语文",
        "語文",
        "英文",
        "数学",
        "數學",
        "数学A",
        "數學A",
        "数学B",
        "數學B",
        "社会",
        "社會",
        "自然",
    }
    if base in subject_bases:
        return False

    # 语言类专业（如 葡萄牙语）
    if base.endswith("语") and len(base) <= 6:
        return True

    score = 0

    # 正向后缀（覆盖大多数专业）
    suffixes = [
        "学",
        "工程",
        "技术",
        "管理",
        "经济",
        "医学",
        "药学",
        "制药",
        "製藥",
        "科学",
        "教育",
        "艺术",
        "设计",
        "商务",
        "营销",
        "工作",
        "关系",
        "安全",
        "系统",
        "工艺",
        "仪器",
        "运输",
        "造价",
        "评估",
        "保险",
        "审计",
        "会计",
        "金融",
        "统计",
        "建筑",
        "测绘",
        "地质",
        "海洋",
        "农学",
        "林学",
        "水利",
        "水产",
        "贸易",
        "园林",
        "规划",
        "器件",
        "理论",
        "表演",
        "导演",
        "编导",
        "播音",
        "摄影",
        "动画",
        "戏剧",
        "影视",
        "服装",
    ]
    if any(base.endswith(suf) for suf in suffixes):
        score += 3

    # 含括号通常是专业方向/细分
    if "(" in s and ")" in s:
        score += 1

    # 常见学科关键词
    keywords = [
        "工程",
        "管理",
        "经济",
        "医学",
        "药",
        "护理",
        "口腔",
        "临床",
        "计算机",
        "软件",
        "数据",
        "网络",
        "信息",
        "智能",
        "人工智能",
        "电子",
        "电气",
        "通信",
        "自动化",
        "机械",
        "材料",
        "环境",
        "能源",
        "土木",
        "建筑",
        "金融",
        "会计",
        "统计",
        "法律",
        "新闻",
        "传播",
        "翻译",
        "艺术",
        "设计",
        "音乐",
        "舞蹈",
        "绘画",
        "摄影",
        "动画",
        "戏剧",
        "影视",
        "表演",
        "导演",
        "编导",
        "播音",
        "体育",
    ]
    if any(k in base for k in keywords):
        score += 1

    # “应用”结尾的专业较多，但也容易误伤；要求同时包含强关键词
    if base.endswith("应用") and any(
        k in base for k in ["管理", "数据", "信息", "技术", "工程", "智能", "医学"]
    ):
        score = max(score, 3)

    return score >= 3


def _split_major_tokens(text: str) -> list:
    s = _norm_parens(str(text or "")).strip()
    if not s:
        return []

    # 常见 "招生专业：..." 取冒号后
    if "：" in s:
        left, right = s.split("：", 1)
        if any(k in left for k in ["招生专业", "招生專業", "专业", "專業"]):
            s = right.strip()

    # 统一分隔符
    for c in ["，", ",", "/", "\\", "；", ";", "、", "|", "｜"]:
        s = s.replace(c, "、")

    # 清理常见编号
    s = re.sub(r"^\(?[一二三四五六七八九十0-9]+\)?[、.．]\s*", "", s)

    parts = [p.strip() for p in s.split("、") if p.strip()]
    return parts


def extract_majors_from_text(text: str, limit: int = 400) -> list:
    """从抓取到的正文中，规则提取招生专业名称列表（尽量全，允许少量噪声）。"""
    raw = (text or "").replace("\r\n", "\n")
    if not raw.strip():
        return []

    lines = [ln.strip() for ln in raw.split("\n") if ln and ln.strip()]
    if not lines:
        return []

    # 仅在含有明显“招生专业”信号时才进入提取，避免把导航/申请材料误当专业
    hints = [
        "招生专业",
        "招生專業",
        "招生专业及计划",
        "招生专业及招生计划",
        "招生专业（类）",
        "招生专业(类)",
        "招生專業（類）",
        "招生專業(類)",
        "招生专业名称",
        "招生專業名稱",
        "专业名称",
        "專業名稱",
        "专业目录",
        "专业及计划",
    ]
    has_hint = any(any(h in ln for h in hints) for ln in lines)
    if not has_hint:
        # 兜底：正文极短时仍尝试
        if len(raw) < 1500:
            pass
        else:
            return []

    stop_hints = [
        "申请方式",
        "申請方式",
        "申请材料",
        "申請材料",
        "报名方式",
        "報名方式",
        "网上报名",
        "網上報名",
        "录取",
        "錄取",
        "奖学金",
        "獎學金",
        "学费",
        "學費",
        "联系方式",
        "聯繫方式",
        "注意事项",
        "注意事項",
    ]

    # 收集“可能是专业表格/清单”的行窗口
    windows = []
    for i, ln in enumerate(lines):
        if any(h in ln for h in hints):
            windows.append((i, min(i + 220, len(lines))))

    if not windows:
        windows = [(0, min(220, len(lines)))]

    # 合并窗口
    windows.sort()
    merged = []
    for a, b in windows:
        if not merged:
            merged.append([a, b])
            continue
        if a <= merged[-1][1] + 10:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])

    majors = []
    seen = set()

    def _add(token: str):
        if not token:
            return
        nm = _normalize_major_name(token)
        if not _is_probable_major_name(nm):
            return
        if nm in seen:
            return
        seen.add(nm)
        majors.append(nm)

    # 1) 在窗口内抽取：行/单元格 -> token
    for a, b in merged:
        hit_any = False
        frag_buf = []

        def _flush_frags():
            nonlocal frag_buf
            if len(frag_buf) >= 2:
                _add("".join(frag_buf))
            frag_buf = []

        for idx in range(a, b):
            ln = lines[idx]

            # 到达下一个大节通常意味着专业段落结束
            if hit_any and any(h in ln for h in stop_hints):
                # 例如 “四、申请方式”
                if re.match(
                    r"^(?:[一二三四五六七八九十]+|[0-9]{1,2})[、.．)]", ln
                ) or re.match(
                    r"^[（(](?:[一二三四五六七八九十]+|[0-9]{1,2})[）)]",
                    ln,
                ):
                    _flush_frags()
                    break

            # 表头/无关字段
            if any(
                k in ln
                for k in [
                    "所属院系",
                    "所属院（系）",
                    "招生专业",
                    "学制",
                    "计划",
                    "人数",
                    "备注",
                ]
            ):
                hit_any = True
                _flush_frags()
                continue

            # 处理可能含有多个专业的行
            for tok in _split_major_tokens(ln):
                # 跳过明显的学制/计划数字
                if re.fullmatch(r"[0-9]+", tok):
                    _flush_frags()
                    continue
                if re.search(r"[一二三四五六七八九十]年制", tok):
                    _flush_frags()
                    continue
                if re.search(r"[0-9]+年制", tok):
                    _flush_frags()
                    continue
                if tok in ("四年制", "五年制", "六年制"):
                    _flush_frags()
                    continue

                nm = _normalize_major_name(tok)
                if _is_probable_major_name(nm):
                    _flush_frags()
                    _add(nm)
                    hit_any = True
                    continue

                # HTML 表格常见把一个专业拆成多个 2 字 span，做一次轻量拼接
                zh_count = sum(1 for ch in nm if "\u4e00" <= ch <= "\u9fff")
                if (
                    len(nm) == 2
                    and zh_count == 2
                    and not any(
                        k in nm
                        for k in [
                            "学院",
                            "院系",
                            "学部",
                            "系",
                            "专业",
                            "计划",
                            "人数",
                            "学制",
                            "年制",
                            "合计",
                            "小计",
                        ]
                    )
                ):
                    frag_buf.append(nm)
                    hit_any = True
                    if len(frag_buf) >= 6:
                        _flush_frags()
                    continue

                _flush_frags()

                hit_any = True

            if len(majors) >= limit:
                _flush_frags()
                break

        _flush_frags()
        if len(majors) >= limit:
            break

    # 2) 全文补充：句式 “招生专业：A、B、C”
    if len(majors) < limit:
        m = re.findall(
            r"招生专业(?:及计划|及招生计划|目录)?\s*[:：]\s*([^。\n]{2,200})",
            raw,
        )
        for chunk in m[:20]:
            for tok in _split_major_tokens(chunk):
                _add(tok)
                if len(majors) >= limit:
                    break
            if len(majors) >= limit:
                break

    return majors[:limit]


def extract_majors_from_department_label(label: str, limit: int = 80) -> list:
    """从 department 字段中尽量拆出具体专业名（仅用于前端展示/筛选）。"""
    s = _normalize_major_name(label)
    if not s:
        return []

    # 对 “理工类专业 / 文史类专业 / 艺术类专业”等泛分类不做拆分
    if "类专业" in s or s.endswith("专业") or s.endswith("專業"):
        # 但若字符串明显是“多个专业并列”，仍允许拆（例如：中医学、针灸推拿学…）
        if "、" not in s and "," not in s and "，" not in s and "/" not in s:
            return []

    majors = []
    seen = set()
    for tok in _split_major_tokens(s):
        nm = _normalize_major_name(tok)
        if not _is_probable_major_name(nm):
            continue
        if nm in seen:
            continue
        seen.add(nm)
        majors.append(nm)
        if len(majors) >= limit:
            break
    return majors


def attach_majors_to_extraction(extraction: dict, text: str) -> dict:
    """将专业列表附加到 extraction / department_requirements（不影响既有字段兼容）。"""
    if not isinstance(extraction, dict):
        return extraction

    majors = extract_majors_from_text(text)
    if majors:
        extraction["majors"] = majors

    depts = extraction.get("department_requirements")
    if isinstance(depts, list) and depts:
        for row in depts:
            if not isinstance(row, dict):
                continue
            # 若 row 已有 majors 则保留，否则尝试从 department 文本拆出
            if isinstance(row.get("majors"), list) and row.get("majors"):
                continue
            dlabel = row.get("department") or ""
            row_majors = extract_majors_from_department_label(str(dlabel))
            if row_majors:
                row["majors"] = row_majors

    return extraction


def add_manual_review_note_if_needed(extraction: dict, text: str) -> dict:
    if not isinstance(extraction, dict):
        return extraction
    if not extraction.get("found"):
        return extraction
    if has_subject_requirements(extraction):
        return extraction

    cleaned = re.sub(r"\s+", "", (text or ""))
    signals = [
        "报名要求",
        "招生计划",
        "学院",
        "专业",
        "学测",
        "台湾",
        "简章",
        "前标",
        "均标",
    ]
    hit = sum(1 for s in signals if s in cleaned)
    if hit >= 3:
        note = extraction.get("notes") or ""
        tail = "可能存在图片/附件中的科目要求，建议人工复核原文与附件。"
        if tail not in note:
            extraction["notes"] = (note + " " + tail).strip()
        if extraction.get("confidence") == "high":
            extraction["confidence"] = "medium"
    return extraction


def result_status_rank(status: str) -> int:
    return {"success": 3, "not_found": 2, "failed": 1}.get(status, 0)


def confidence_rank(conf: str) -> int:
    return {"high": 3, "medium": 2, "low": 1}.get((conf or "").lower(), 0)


def source_quality_rank(result: Optional[dict]) -> int:
    if not isinstance(result, dict):
        return -10_000

    score = 0
    source = (result.get("source") or "").lower()
    if source == "official":
        score += 150
    elif source == "search":
        score += 20

    host = urlparse((result.get("source_url") or "").strip()).netloc.lower()
    if ".edu.cn" in host or host.endswith(".edu"):
        score += 120
    if ".gov.cn" in host:
        score += 80
    if any(k in host for k in ["zsb", "admission", "zhaosheng", "bkzs", "recruit"]):
        score += 60
    if any(bad in host for bad in LOW_QUALITY_HOST_HINTS):
        score -= 220

    score += min((result.get("raw_text_length") or 0) // 200, 60)
    return score


def _merge_unique_str_list(
    a: Optional[list], b: Optional[list], limit: int = 600
) -> list:
    out = []
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


def merge_major_fields(target: dict, donor: Optional[dict]) -> dict:
    """将 donor 中识别到的 majors 合并到 target（用于重跑时补全专业列表）。"""
    if not isinstance(target, dict) or not isinstance(donor, dict):
        return target

    te = target.get("extraction")
    de = donor.get("extraction")
    if not isinstance(te, dict) or not isinstance(de, dict):
        return target

    merged_majors = _merge_unique_str_list(te.get("majors"), de.get("majors"))
    if merged_majors:
        te["majors"] = merged_majors

    tdepts = te.get("department_requirements")
    ddepts = de.get("department_requirements")
    if isinstance(tdepts, list) and isinstance(ddepts, list) and tdepts and ddepts:
        donor_map = {}
        for row in ddepts:
            if not isinstance(row, dict):
                continue
            k = str(row.get("department") or "").strip()
            if k and k not in donor_map:
                donor_map[k] = row

        for row in tdepts:
            if not isinstance(row, dict):
                continue
            k = str(row.get("department") or "").strip()
            src = donor_map.get(k)
            if not isinstance(src, dict):
                continue
            merged_row = _merge_unique_str_list(
                row.get("majors"), src.get("majors"), limit=200
            )
            if merged_row:
                row["majors"] = merged_row

    return target


def choose_better_result(existing: Optional[dict], current: dict) -> dict:
    """在同校多次重跑中选择更可靠结果，避免退化。"""
    if not existing:
        return current

    er = result_status_rank(existing.get("status"))
    cr = result_status_rank(current.get("status"))

    chosen = None
    other = None

    if er > cr:
        chosen, other = existing, current
    elif cr > er:
        chosen, other = current, existing
    else:
        # 同状态时做细化比较
        if (existing.get("status") or "") == "success":
            e_ext = existing.get("extraction") or {}
            c_ext = current.get("extraction") or {}
            e_has = has_subject_requirements(e_ext)
            c_has = has_subject_requirements(c_ext)

            if e_has and not c_has:
                chosen, other = existing, current
            elif c_has and not e_has:
                chosen, other = current, existing
            else:
                # 科目完备度相同，按置信度与文本长度
                ec = confidence_rank(e_ext.get("confidence"))
                cc = confidence_rank(c_ext.get("confidence"))
                if ec > cc:
                    chosen, other = existing, current
                elif cc > ec:
                    chosen, other = current, existing
                else:
                    if (existing.get("raw_text_length") or 0) >= (
                        current.get("raw_text_length") or 0
                    ):
                        chosen, other = existing, current
                    else:
                        chosen, other = current, existing
        else:
            # not_found / failed 同级时，保留已有，避免频繁抖动
            eq = source_quality_rank(existing)
            cq = source_quality_rank(current)
            if cq > eq:
                chosen, other = current, existing
            elif eq > cq:
                chosen, other = existing, current
            else:
                # 来源质量相当时，保留文本更长的一条
                if (current.get("raw_text_length") or 0) > (
                    existing.get("raw_text_length") or 0
                ):
                    chosen, other = current, existing
                else:
                    chosen, other = existing, current

    if chosen is None:
        chosen, other = existing, current

    # 无论选择哪一个，都尽量把专业列表补全进 chosen
    return merge_major_fields(chosen, other)


def load_results() -> dict:
    """加载已有结果"""
    if os.path.exists(RESULTS_FILE):
        with open(RESULTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"schools": {}, "last_updated": None}


def save_results(results: dict):
    """保存结果"""
    results["last_updated"] = datetime.now().isoformat()
    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


@app.get("/api/schools")
async def get_schools():
    """获取学校列表"""
    # 尝试从缓存读取
    if os.path.exists(SCHOOLS_FILE):
        with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
            schools = json.load(f)
    else:
        schools = await fetch_school_list()
        with open(SCHOOLS_FILE, "w", encoding="utf-8") as f:
            json.dump(schools, f, ensure_ascii=False, indent=2)

    return {"schools": schools, "total": len(schools)}


@app.get("/api/results")
async def get_results():
    """获取提取结果"""
    results = load_results()
    return results


@app.get("/api/results/{school_id}")
async def get_school_result(school_id: str):
    """获取单个学校的结果"""
    results = load_results()
    if school_id in results["schools"]:
        return results["schools"][school_id]
    raise HTTPException(status_code=404, detail="未找到该学校的结果")


@app.get("/api/status")
async def get_status():
    """获取任务状态"""
    return task_status


@app.post("/api/sync-labels")
async def sync_labels_online():
    """联网同步学校类别与台湾承认标签"""
    if task_status["running"]:
        raise HTTPException(status_code=400, detail="任务正在运行中，请稍后再试")

    try:
        # 确保学校列表存在
        if not os.path.exists(SCHOOLS_FILE):
            await get_schools()

        with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
            schools = json.load(f)

        online_sets = await asyncio.to_thread(build_online_sets, schools)
        schools_stats = await asyncio.to_thread(apply_to_schools, online_sets)
        results_stats = await asyncio.to_thread(apply_to_results)

        return {
            "message": "标签同步完成",
            "schools_stats": schools_stats,
            "results_stats": results_stats,
            "sources": ONLINE_SOURCES,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"同步失败: {e}")


@app.post("/api/start")
async def start_task(request: TaskRequest, background_tasks: BackgroundTasks):
    """启动提取任务"""
    if task_status["running"]:
        raise HTTPException(status_code=400, detail="任务正在运行中")

    background_tasks.add_task(
        run_extraction_task,
        request.school_ids,
        request.use_search_fallback,
        request.force_refresh,
    )

    return {"message": "任务已启动"}


@app.post("/api/stop")
async def stop_task():
    """停止任务"""
    task_status["running"] = False
    return {"message": "正在停止任务"}


@app.post("/api/process/{school_id}")
async def process_single_school(school_id: str, use_search: bool = True):
    """处理单个学校"""
    # 加载学校列表
    if not os.path.exists(SCHOOLS_FILE):
        await get_schools()

    with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
        schools = json.load(f)

    school = next((s for s in schools if str(s["id"]) == school_id), None)
    if not school:
        raise HTTPException(status_code=404, detail="学校不存在")

    async with httpx.AsyncClient(
        headers=HEADERS, timeout=60, follow_redirects=True, verify=False
    ) as client:
        result = await process_school(school, client, use_search)

    # 保存结果
    results = load_results()
    existing = results["schools"].get(school_id)

    result = choose_better_result(existing, result)

    results["schools"][school_id] = result
    save_results(results)

    return result


async def process_school(
    school: dict, client: httpx.AsyncClient, use_search_fallback: bool = True
) -> dict:
    """处理单个学校的完整流程"""
    school_id = str(school["id"])
    school_name = school["name"]

    result = {
        "school_id": school_id,
        "school_name": school_name,
        "area": school.get("area", ""),
        "type": school.get("type", ""),
        "tier": school.get(
            "tier", classify_school(school_name, school.get("type", ""))
        ),
        "taiwan_recognized": school.get(
            "taiwan_recognized", is_taiwan_recognized(school_name)
        ),
        "processed_at": datetime.now().isoformat(),
        "source_url": None,
        "extraction": None,
        "status": "pending",
    }

    def status_rank(status: str) -> int:
        return {"success": 3, "not_found": 2, "failed": 1}.get(status, 0)

    def status_from_extraction(extraction: dict) -> str:
        if extraction.get("error"):
            return "failed"
        return "success" if extraction.get("found") else "not_found"

    async def build_attempt(
        source_url: str,
        text: str,
        source: str = "official",
        related_links: Optional[list] = None,
        image_links: Optional[list] = None,
        allow_short: bool = False,
    ) -> dict:
        extraction = await extract_requirements(
            school_name,
            text,
            allow_short=allow_short,
        )
        extraction = await validate_and_enhance(extraction, school_name)
        extraction = normalize_extraction_structure(extraction)
        extraction = heuristic_fill_requirements(extraction, text)

        # 文本仍无科目要求时，尝试视觉提取（图片表格场景）
        if extraction.get("found") and not has_subject_requirements(extraction):
            if image_links:
                candidate_images = []
                for u in image_links:
                    lu = (u or "").lower()
                    if any(
                        k in lu
                        for k in [
                            "logo",
                            "banner",
                            "footer",
                            "icon",
                            "menu",
                            "close",
                            "wx",
                            "qrcode",
                            "zscode",
                        ]
                    ):
                        continue
                    candidate_images.append(u)

                if not candidate_images:
                    candidate_images = image_links

                img_extraction = await extract_requirements_from_images(
                    school_name, candidate_images[:2]
                )
                img_extraction = await validate_and_enhance(img_extraction, school_name)
                img_extraction = normalize_extraction_structure(img_extraction)
                img_extraction = heuristic_fill_requirements(img_extraction, text)
                if img_extraction.get("found") and has_subject_requirements(
                    img_extraction
                ):
                    extraction = img_extraction

        extraction = add_manual_review_note_if_needed(extraction, text)
        extraction = attach_majors_to_extraction(extraction, text)
        return {
            "source_url": source_url,
            "source": source,
            "extraction": extraction,
            "status": status_from_extraction(extraction),
            "raw_text_length": len(text),
            "related_links": related_links or [],
            "image_links": image_links or [],
        }

    def build_failed_attempt(
        source_url: str,
        error_msg: str,
        raw_text_length: int = 0,
        source: str = "official",
    ) -> dict:
        return {
            "source_url": source_url,
            "source": source,
            "extraction": {
                "found": False,
                "error": error_msg,
                "confidence": "low",
                "school_name": school_name,
            },
            "status": "failed",
            "raw_text_length": raw_text_length,
        }

    def build_not_found_attempt(
        source_url: str,
        reason: str,
        raw_text_length: int = 0,
        source: str = "official",
    ) -> dict:
        return {
            "source_url": source_url,
            "source": source,
            "extraction": {
                "found": False,
                "error": None,
                "confidence": "low",
                "school_name": school_name,
                "notes": reason,
            },
            "status": "not_found",
            "raw_text_length": raw_text_length,
        }

    def short_text_has_signals(text: str) -> bool:
        t = re.sub(r"\s+", "", text or "")
        if len(t) < 30:
            return False
        core = [
            "2026",
            "台湾",
            "台灣",
            "学测",
            "學測",
            "学科能力测试",
            "学科能力测验",
            "學科能力測驗",
            "學科能力測試",
            "简章",
            "簡章",
            "前标",
            "均标",
            "顶标",
        ]
        hit = sum(1 for k in core if k in t)
        return hit >= 2

    def apply_attempt(attempt: dict):
        result["source_url"] = attempt.get("source_url")
        result["source"] = attempt.get("source")
        result["extraction"] = attempt.get("extraction")
        result["status"] = attempt.get("status", "failed")
        result["raw_text_length"] = attempt.get("raw_text_length", 0)
        result["related_links"] = attempt.get("related_links", [])
        result["image_links"] = attempt.get("image_links", [])

        if result["status"] == "failed":
            err = None
            if isinstance(result.get("extraction"), dict):
                err = result["extraction"].get("error")
            result["error"] = err or "无法获取招生简章内容"
        else:
            result.pop("error", None)

    attempts = []

    # 1. 尝试官方链接
    zsjz_url = school.get("zsjz_url")
    if zsjz_url:
        print(f"[{school_name}] 尝试官方链接: {zsjz_url}")
        page_result = await fetch_page_content(zsjz_url, client)
        print(
            f"[{school_name}] 获取结果: success={page_result['success']}, text_len={len(page_result.get('text', ''))}, error={page_result.get('error')}"
        )

        if page_result["success"] and page_result.get("text"):
            # 如果页面有PDF链接，尝试获取PDF
            if page_result.get("pdf_links"):
                for pdf_link in page_result["pdf_links"][:2]:  # 最多尝试2个PDF
                    link_text = pdf_link.get("text") or ""
                    link_url = (pdf_link.get("url") or "").lower()
                    if any(
                        kw in link_text
                        for kw in ["2026", "台湾", "学测", "简章", "附件"]
                    ) or any(
                        k in link_url
                        for k in [
                            ".pdf",
                            ".doc",
                            ".docx",
                            ".xls",
                            ".xlsx",
                            "download",
                            "attachment",
                        ]
                    ):
                        await asyncio.sleep(REQUEST_DELAY_MS / 1000)
                        pdf_result = await fetch_page_content(pdf_link["url"], client)
                        if pdf_result["success"]:
                            page_result["text"] += (
                                "\n\n--- PDF内容 ---\n" + pdf_result["text"]
                            )
                            break

            official_text = page_result.get("text", "")
            related_links = []
            image_links = page_result.get("image_links", []) or []

            # 若入口页是列表/导航页，继续追踪候选二跳链接（2026+台湾/学测/简章）
            if page_result.get("html"):
                related = await fetch_related_content(
                    zsjz_url,
                    page_result.get("html") or "",
                    client,
                    school_name=school_name,
                    max_links=4,
                )
                if related.get("links"):
                    related_links = related.get("links") or []
                extra_images = related.get("image_links") or []
                if extra_images:
                    image_links = list(
                        dict.fromkeys((image_links or []) + extra_images)
                    )
                if related.get("success") and related.get("text"):
                    official_text += "\n\n--- 入口页关联子链接补充 ---\n" + related.get(
                        "text", ""
                    )
            if len(official_text.strip()) < 100 and not short_text_has_signals(
                official_text
            ):
                print(f"[{school_name}] 官方内容过短，改用搜索回退")
                attempts.append(
                    build_not_found_attempt(
                        zsjz_url,
                        "内容过短或为空",
                        raw_text_length=len(official_text),
                        source="official",
                    )
                )
            else:
                attempt = await build_attempt(
                    zsjz_url,
                    official_text,
                    source="official",
                    related_links=related_links,
                    image_links=image_links,
                    allow_short=len(official_text.strip()) < 100,
                )
                attempts.append(attempt)
                if attempt["status"] == "success":
                    apply_attempt(attempt)
                    return result
                print(
                    f"[{school_name}] 官方提取状态={attempt['status']}，继续尝试搜索回退"
                )
        else:
            attempts.append(
                build_failed_attempt(
                    zsjz_url,
                    page_result.get("error") or "官方链接获取失败",
                    source="official",
                )
            )

    # 2. 搜索引擎fallback
    # 2.5 根域兜底：官方链接失效/过短时，尝试学校站点首页再追踪一层
    if zsjz_url:
        try:
            parsed = urlparse(zsjz_url)
            root_url = f"{parsed.scheme}://{parsed.netloc}/" if parsed.netloc else ""
        except Exception:
            root_url = ""

        if root_url and root_url.rstrip("/") != (zsjz_url or "").rstrip("/"):
            await asyncio.sleep(REQUEST_DELAY_MS / 1000)
            root_page = await fetch_page_content(root_url, client)

            if root_page.get("success") and root_page.get("text"):
                root_text = root_page.get("text") or ""
                root_related_links = []
                root_images = root_page.get("image_links") or []

                if root_page.get("html"):
                    root_related = await fetch_related_content(
                        root_url,
                        root_page.get("html") or "",
                        client,
                        school_name=school_name,
                        max_links=6,
                    )
                    if root_related.get("links"):
                        root_related_links = root_related.get("links") or []
                    extra_root_images = root_related.get("image_links") or []
                    if extra_root_images:
                        root_images = list(
                            dict.fromkeys(root_images + extra_root_images)
                        )
                    if root_related.get("success") and root_related.get("text"):
                        root_text += (
                            "\n\n--- 根域关联子链接补充 ---\n"
                            + root_related.get("text", "")
                        )

                if len(root_text.strip()) < 100 and not short_text_has_signals(
                    root_text
                ):
                    attempts.append(
                        build_not_found_attempt(
                            root_url,
                            "根域页面内容过短或为空",
                            raw_text_length=len(root_text),
                            source="root_scan",
                        )
                    )
                else:
                    attempt = await build_attempt(
                        root_url,
                        root_text,
                        source="root_scan",
                        related_links=root_related_links,
                        image_links=root_images,
                        allow_short=len(root_text.strip()) < 100,
                    )
                    attempts.append(attempt)
                    if attempt["status"] == "success":
                        apply_attempt(attempt)
                        return result
            else:
                attempts.append(
                    build_failed_attempt(
                        root_url,
                        root_page.get("error") or "根域页面获取失败",
                        source="root_scan",
                    )
                )

    # 3. 搜索引擎fallback
    if use_search_fallback:
        await asyncio.sleep(REQUEST_DELAY_MS / 1000)
        search_result = await search_fallback(school_name, client, zsjz_url or "")

        if search_result["success"] and search_result.get("text"):
            final_url = search_result.get("final_url", search_result["url"])
            search_text = search_result.get("text", "")
            search_related_links = []
            search_image_links = search_result.get("image_links", []) or []

            # 搜索命中页同样执行二跳追踪，避免停留在列表页
            try:
                seed_page = await fetch_page_content(final_url, client)
                extra_seed_images = seed_page.get("image_links") or []
                if extra_seed_images:
                    search_image_links = list(
                        dict.fromkeys(search_image_links + extra_seed_images)
                    )

                if seed_page.get("html"):
                    search_related = await fetch_related_content(
                        final_url,
                        seed_page.get("html") or "",
                        client,
                        school_name=school_name,
                        max_links=4,
                    )
                    if search_related.get("links"):
                        search_related_links = search_related.get("links") or []
                    extra_related_images = search_related.get("image_links") or []
                    if extra_related_images:
                        search_image_links = list(
                            dict.fromkeys(search_image_links + extra_related_images)
                        )
                    if search_related.get("success") and search_related.get("text"):
                        search_text += (
                            "\n\n--- 搜索结果关联子链接补充 ---\n"
                            + search_related.get("text", "")
                        )
            except Exception:
                pass

            if len(search_text.strip()) < 100 and not short_text_has_signals(
                search_text
            ):
                attempts.append(
                    build_not_found_attempt(
                        final_url,
                        "内容过短或为空",
                        raw_text_length=len(search_text),
                        source="search",
                    )
                )
            else:
                attempt = await build_attempt(
                    final_url,
                    search_text,
                    source="search",
                    related_links=search_related_links,
                    image_links=search_image_links,
                    allow_short=len(search_text.strip()) < 100,
                )
                attempts.append(attempt)
                if attempt["status"] == "success":
                    apply_attempt(attempt)
                    return result
        else:
            attempts.append(
                build_not_found_attempt(
                    search_result.get("url", zsjz_url or ""),
                    search_result.get("error") or "搜索回退未找到有效内容",
                    source="search",
                )
            )

    if attempts:
        best_attempt = max(
            attempts, key=lambda x: status_rank(x.get("status", "failed"))
        )
        apply_attempt(best_attempt)
        return result

    apply_attempt(
        build_not_found_attempt(
            zsjz_url or "",
            "无法获取招生简章内容",
            source="official",
        )
    )
    return result


async def run_extraction_task(
    school_ids: list, use_search_fallback: bool, force_refresh: bool
):
    """运行批量提取任务"""
    global task_status

    # 加载学校列表
    if not os.path.exists(SCHOOLS_FILE):
        schools = await fetch_school_list()
        with open(SCHOOLS_FILE, "w", encoding="utf-8") as f:
            json.dump(schools, f, ensure_ascii=False, indent=2)
    else:
        with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
            schools = json.load(f)

    # 筛选要处理的学校
    if school_ids:
        schools = [s for s in schools if str(s["id"]) in school_ids]

    # 加载已有结果
    results = load_results()

    # 避免并发写入 results.json 导致内容损坏/丢数据
    results_lock = asyncio.Lock()

    # 如果不强制刷新，跳过已有结果
    if not force_refresh:
        existing_ids = set(results["schools"].keys())
        schools = [s for s in schools if str(s["id"]) not in existing_ids]

    # 初始化状态
    task_status = {
        "running": True,
        "current_school": None,
        "progress": 0,
        "total": len(schools),
        "completed": [],
        "failed": [],
        "start_time": datetime.now().isoformat(),
    }

    # 使用信号量控制并发
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def process_with_semaphore(school):
        async with semaphore:
            if not task_status["running"]:
                return None

            task_status["current_school"] = school["name"]

            async with httpx.AsyncClient(
                headers=HEADERS, timeout=60, follow_redirects=True, verify=False
            ) as client:
                result = await process_school(school, client, use_search_fallback)

            async with results_lock:
                school_key = str(school["id"])

                # 若本次结果比已有结果更差，则保留已有结果，避免重跑导致回退
                existing = results["schools"].get(school_key)
                result = choose_better_result(existing, result)

                # 更新状态
                task_status["progress"] += 1
                if result["status"] in ("success", "not_found"):
                    task_status["completed"].append(school["name"])
                else:
                    task_status["failed"].append(school["name"])

                # 保存结果
                results["schools"][school_key] = result
                save_results(results)

            # 延迟
            await asyncio.sleep(REQUEST_DELAY_MS / 1000)

            return result

    # 并发处理
    tasks = [process_with_semaphore(school) for school in schools]
    await asyncio.gather(*tasks)

    task_status["running"] = False
    task_status["current_school"] = None


@app.post("/api/retry-failed")
async def retry_failed(background_tasks: BackgroundTasks):
    """重跑所有 failed 和 not_found 的学校"""
    if task_status["running"]:
        raise HTTPException(status_code=400, detail="任务正在运行中")

    results = load_results()
    retry_ids = [
        sid
        for sid, data in results["schools"].items()
        if data.get("status") in ("failed", "not_found")
    ]

    if not retry_ids:
        return {"message": "没有需要重试的学校", "count": 0}

    background_tasks.add_task(
        run_extraction_task,
        retry_ids,
        True,  # use_search_fallback
        True,  # force_refresh
    )

    return {"message": f"开始重试 {len(retry_ids)} 所学校", "count": len(retry_ids)}


@app.get("/api/export")
async def export_results():
    """导出结果为简化格式"""
    results = load_results()

    export_data = []
    for school_id, data in results["schools"].items():
        if data.get("extraction", {}).get("found"):
            ext = data["extraction"]
            export_data.append(
                {
                    "school_name": data["school_name"],
                    "area": data.get("area", ""),
                    "type": data.get("type", ""),
                    "tier": data.get("tier", ""),
                    "taiwan_recognized": data.get("taiwan_recognized", False),
                    "general_requirements": ext.get("general_requirements"),
                    "department_requirements": ext.get("department_requirements"),
                    "other_conditions": ext.get("other_conditions"),
                    "application_deadline": ext.get("application_deadline"),
                    "confidence": ext.get("confidence"),
                    "source_url": data.get("source_url"),
                }
            )

    return {"data": export_data, "total": len(export_data)}


# 静态文件服务 - 放在最后以避免覆盖API路由
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.exists(frontend_path):

    @app.get("/summary")
    async def summary_page():
        fp = os.path.join(frontend_path, "summary.html")
        if os.path.exists(fp):
            return FileResponse(fp, media_type="text/html")
        return RedirectResponse("/")

    @app.get("/summary/")
    async def summary_page_slash():
        return RedirectResponse("/summary")

    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4567)
