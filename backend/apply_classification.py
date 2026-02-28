"""
在线同步学校标签：
1) 学校类别（985 / 211 / 双一流 / 非双一流）
2) 台湾教育部承认（优先按台湾教育部名册中的官网域名匹配）

并回写：
- data/schools.json
- data/results.json
"""

import argparse
import io
import json
import os
import re
import sys
from datetime import datetime
from typing import Dict, Iterable, Optional, Set, Tuple
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader

# 确保能导入同目录模块
sys.path.insert(0, os.path.dirname(__file__))
from school_classification import classify_school, is_taiwan_recognized


DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
SCHOOLS_FILE = os.path.join(DATA_DIR, "schools.json")
RESULTS_FILE = os.path.join(DATA_DIR, "results.json")
REPORT_FILE = os.path.join(DATA_DIR, "online_label_sync_report.json")


ONLINE_SOURCES = {
    "moe_985": "https://www.moe.gov.cn/srcsite/A22/s7065/200612/t20061206_128833.html",
    "moe_211": "https://www.moe.gov.cn/srcsite/A22/s7065/200512/t20051223_82762.html",
    "moe_shuangyiliu_pdf": "https://www.moe.gov.cn/srcsite/A22/s7065/202202/W020220214318455516037.pdf",
    "tw_moe_recognized_pdf": "https://ws.moe.edu.tw/001/Upload/4/relfile/7840/100694/65a057d3-f1f9-4829-90ea-ea196abaafd8.pdf",
}

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def normalize_text(text: str) -> str:
    text = text or ""
    text = text.replace("（", "(").replace("）", ")")
    text = text.replace("·", "")
    text = re.sub(r"\s+", "", text)
    return text


def name_aliases(name: str) -> Set[str]:
    n = normalize_text(name)
    aliases = {n}

    # 去掉括号内容，例如 中国石油大学(北京) -> 中国石油大学
    base = re.sub(r"\([^)]*\)", "", n)
    if base:
        aliases.add(base)

    # 常见后缀变体
    for suffix in ["珠海校区", "北京", "武汉", "华东", "保定", "徐州"]:
        if base.endswith(suffix) and len(base) > len(suffix) + 1:
            aliases.add(base[: -len(suffix)])

    return {a for a in aliases if len(a) >= 4}


def fetch_html_text(url: str) -> str:
    resp = requests.get(url, headers=REQUEST_HEADERS, timeout=60)
    resp.raise_for_status()
    # 教育部老页面常缺少 charset，强制 utf-8
    resp.encoding = "utf-8"
    soup = BeautifulSoup(resp.text, "lxml")
    return soup.get_text("\n")


def fetch_pdf_text(url: str) -> str:
    resp = requests.get(url, headers=REQUEST_HEADERS, timeout=60)
    resp.raise_for_status()
    reader = PdfReader(io.BytesIO(resp.content))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def extract_domains_from_tw_pdf(text: str) -> Set[str]:
    # 处理 PDF 抽取后 URL 中被插入空格的情况
    fixed = (text or "").replace("http:// ", "http://").replace("https:// ", "https://")
    urls = re.findall(r"https?://[^\s\)）]+", fixed)

    domains = set()
    for u in urls:
        host = urlparse(u).netloc.lower().split(":")[0]
        if host.startswith("www."):
            host = host[4:]
        if host:
            domains.add(host)
    return domains


def extract_host_from_mixed_url(value: str) -> Optional[str]:
    if not value:
        return None

    m = re.search(r"https?://[^\s,，；;]+", value)
    if not m:
        return None

    host = urlparse(m.group(0)).netloc.lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    return host or None


def domain_matches(host: str, candidate_domains: Iterable[str]) -> bool:
    for d in candidate_domains:
        if host == d:
            return True
        if host.endswith("." + d):
            return True
        if d.endswith("." + host):
            return True
    return False


def match_names_in_text(names: Iterable[str], normalized_text: str) -> Set[str]:
    matched = set()
    for name in names:
        if any(alias in normalized_text for alias in name_aliases(name)):
            matched.add(name)
    return matched


def build_online_sets(schools: list) -> Dict:
    names = [s["name"] for s in schools]

    text_985 = normalize_text(fetch_html_text(ONLINE_SOURCES["moe_985"]))
    text_211 = normalize_text(fetch_html_text(ONLINE_SOURCES["moe_211"]))
    text_syl = normalize_text(fetch_pdf_text(ONLINE_SOURCES["moe_shuangyiliu_pdf"]))
    text_tw_pdf = fetch_pdf_text(ONLINE_SOURCES["tw_moe_recognized_pdf"])

    set_985 = match_names_in_text(names, text_985)
    set_211 = match_names_in_text(names, text_211)
    set_syl = match_names_in_text(names, text_syl)

    # 台湾认可：优先使用台湾教育部官方名册 PDF 里的学校官网域名匹配
    tw_domains = extract_domains_from_tw_pdf(text_tw_pdf)
    tw_by_domain = set()
    tw_fallback_static = set()

    for school in schools:
        name = school.get("name", "")
        host = extract_host_from_mixed_url(school.get("zsjz_url", ""))
        if host and domain_matches(host, tw_domains):
            tw_by_domain.add(name)
        elif is_taiwan_recognized(name):
            # 域名匹配不到时，用本地兜底名单（保留兼容）
            tw_fallback_static.add(name)

    return {
        "set_985": set_985,
        "set_211": set_211,
        "set_shuangyiliu": set_syl,
        "set_taiwan_domain": tw_by_domain,
        "set_taiwan_fallback": tw_fallback_static,
        "tw_domains_count": len(tw_domains),
    }


def classify_with_online(
    name: str, type_str: str, online_sets: Dict
) -> Tuple[str, str]:
    if name in online_sets["set_985"]:
        return "985", "online_moe_985"
    if name in online_sets["set_211"]:
        return "211", "online_moe_211"
    if name in online_sets["set_shuangyiliu"]:
        return "双一流", "online_moe_shuangyiliu"

    # 兜底：保留既有逻辑（例如 type 字段为"双一流建设高校"）
    return classify_school(name, type_str), "fallback_local"


def taiwan_with_online(name: str, online_sets: Dict) -> Tuple[bool, str]:
    if name in online_sets["set_taiwan_domain"]:
        return True, "online_tw_moe_domain"
    if name in online_sets["set_taiwan_fallback"]:
        return True, "fallback_local"
    return False, "online_tw_moe_domain"


def apply_to_schools(online_sets: Optional[Dict]) -> Dict:
    with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
        schools = json.load(f)

    stats = {"985": 0, "211": 0, "双一流": 0, "非双一流": 0}
    tw_count = 0

    for school in schools:
        name = school.get("name", "")
        type_str = school.get("type", "")

        if online_sets:
            tier, tier_source = classify_with_online(name, type_str, online_sets)
            tw, tw_source = taiwan_with_online(name, online_sets)
        else:
            tier = classify_school(name, type_str)
            tw = is_taiwan_recognized(name)
            tier_source = "fallback_local"
            tw_source = "fallback_local"

        school["tier"] = tier
        school["tier_source"] = tier_source
        school["taiwan_recognized"] = tw
        school["taiwan_source"] = tw_source

        stats[tier] = stats.get(tier, 0) + 1
        if tw:
            tw_count += 1

    with open(SCHOOLS_FILE, "w", encoding="utf-8") as f:
        json.dump(schools, f, ensure_ascii=False, indent=2)

    print("=== schools.json 更新完成 ===")
    print(f"  总计: {len(schools)} 所学校")
    for tier, count in stats.items():
        print(f"  {tier}: {count}")
    print(f"  台湾承认: {tw_count}")

    return {
        "total": len(schools),
        "tier_stats": stats,
        "taiwan_recognized": tw_count,
    }


def apply_to_results() -> Dict:
    with open(RESULTS_FILE, "r", encoding="utf-8") as f:
        results = json.load(f)

    with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
        schools = json.load(f)
    school_map = {str(s["id"]): s for s in schools}

    updated = 0
    for school_id, data in results.get("schools", {}).items():
        if school_id in school_map:
            s = school_map[school_id]
            data["tier"] = s.get("tier")
            data["tier_source"] = s.get("tier_source", "fallback_local")
            data["taiwan_recognized"] = s.get("taiwan_recognized", False)
            data["taiwan_source"] = s.get("taiwan_source", "fallback_local")
        else:
            # 理论上不应发生，保底
            name = data.get("school_name", "")
            type_str = data.get("type", "")
            data["tier"] = classify_school(name, type_str)
            data["tier_source"] = "fallback_local"
            data["taiwan_recognized"] = is_taiwan_recognized(name)
            data["taiwan_source"] = "fallback_local"
        updated += 1

    with open(RESULTS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print("\n=== results.json 更新完成 ===")
    print(f"  更新了 {updated} 条记录")

    return {"updated": updated}


def save_report(report: Dict):
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


def main():
    parser = argparse.ArgumentParser(description="同步在线学校标签")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="仅使用本地名单，不联网拉取官方来源",
    )
    args = parser.parse_args()

    online_sets = None
    report = {
        "synced_at": datetime.now().isoformat(),
        "mode": "offline" if args.offline else "online",
        "sources": ONLINE_SOURCES,
    }

    if not args.offline:
        print("正在联网拉取官方标签来源...")
        try:
            with open(SCHOOLS_FILE, "r", encoding="utf-8") as f:
                schools = json.load(f)
            online_sets = build_online_sets(schools)
            report["online_sets"] = {
                "matched_985": len(online_sets["set_985"]),
                "matched_211": len(online_sets["set_211"]),
                "matched_shuangyiliu": len(online_sets["set_shuangyiliu"]),
                "matched_taiwan_by_domain": len(online_sets["set_taiwan_domain"]),
                "matched_taiwan_fallback": len(online_sets["set_taiwan_fallback"]),
                "tw_domains_count": online_sets["tw_domains_count"],
            }
        except Exception as e:
            print(f"[警告] 在线同步失败，回退到本地名单: {e}")
            report["online_error"] = str(e)
            online_sets = None

    schools_stats = apply_to_schools(online_sets)
    results_stats = apply_to_results()

    report["schools_stats"] = schools_stats
    report["results_stats"] = results_stats
    save_report(report)

    print(f"\n报告已写入: {REPORT_FILE}")
    print("\n全部完成！")


if __name__ == "__main__":
    main()
