# CAC 繁星推荐（历史资料）提取

本目录新增了一个离线管线脚本，用于从 CAC 历史资料 PDF（录取标准一览表）里抽取结构化 JSON，供后续前端页面做“近三年对比 / 条件筛选”。

## 依赖

- 已复用现有 `.env` 中的 `OPENAI_API_BASE` / `OPENAI_API_KEY` / `OPENAI_MODEL`
- 需要 Python 环境可用（建议先 `pip install -r backend/requirements.txt`）

说明：脚本内部用到了 `PyMuPDF(fitz)` 读取 PDF 页面文字；如果你的环境没有 PyMuPDF，需要额外安装：

```bash
pip install pymupdf
```

## 使用

1) 先看会处理哪些学校（不下载/不跑 AI）：

```bash
python backend/cac_star_pipeline.py --dry-run
```

2) 小范围试跑（建议先从 1-2 所学校开始）：

```bash
python backend/cac_star_pipeline.py --years 114 --schools 001 --max-pages 2
```

3) 全量跑（注意：会触发大量 AI 调用，成本与耗时都较高）：

```bash
python backend/cac_star_pipeline.py --years 112,113,114 --max-pages 0
```

## 输出与缓存

- 输出文件默认写到：`data/cac_star/history_<years>.json`
- 程序会自动生成/复用校系目录映射：`data/cac_star/program_catalog_115.json`
- PDF 下载缓存：`data/cac_star/pdfs/<year>/`（已在 `.gitignore` 中忽略）
- AI 分页缓存：`data/cac_star/cache/<year>/<school_code>/page_XX.json`（已忽略）

常用参数：

- `--max-pages 2`：默认只抽前 2 页，先验证质量/成本
- `--max-pages 0`：抽取整份 PDF 全部页
- `--delay-ms`：放慢请求速度，降低 CAC/模型限流风险
- `--force-ai`：忽略缓存强制重跑 AI
- `--refresh-catalog`：强制刷新 `program_catalog_115.json`
