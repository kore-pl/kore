#!/usr/bin/env bash
# kore 文档站索引生成器（M5-B）
# 零依赖：仅用 python3 标准库扫描 docs/*.md 与 docs/DECISIONS/*.md，
# 输出 docs/site/docs.js（内嵌 window.KORE_DOCS = [...]，断网 file:// 可开，零 fetch）。
# 用法: bash docs/site/build-index.sh
# 退出码: 成功 0；python3 缺失或扫描失败非 0。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v python3 >/dev/null 2>&1 || { echo "build-index: 需要 python3（标准库即可）" >&2; exit 1; }

python3 - "$ROOT" <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
docs_dir = root / "docs"
site_dir = docs_dir / "site"
out_path = site_dir / "docs.js"

# 顶层文档 → 分类（6 类对齐文档站导航；新增文档默认落入"其它设计"并告警）
CATEGORY = {
    "VISION.md": "愿景与设计",
    "ARCHITECTURE.md": "愿景与设计",
    "V1-GOALS.md": "愿景与设计",
    "SCENARIOS.md": "愿景与设计",
    "PLAN.md": "愿景与设计",
    "ROADMAP.md": "愿景与设计",
    "MILESTONE-M0.md": "愿景与设计",
    "MILESTONE-M1.md": "愿景与设计",
    "FEATURE-PARITY.md": "愿景与设计",
    "PARITY-GAP.md": "愿景与设计",
    "GLOSSARY.md": "愿景与设计",
    "PLUGIN-CATALOG.md": "愿景与设计",
    "CORE.md": "内核与协议",
    "PLUGIN-PROTOCOL.md": "内核与协议",
    "PLUGIN-SDK.md": "内核与协议",
    "REPOS.md": "内核与协议",
    "RESOURCE-MODEL.md": "资源与数据",
    "DATA-MODEL.md": "资源与数据",
    "COMPATIBILITY.md": "资源与数据",
    "FRONTEND.md": "前端与安全",
    "SECURITY.md": "前端与安全",
    "OPEN-SOURCE.md": "治理与开源",
}
CATEGORY_ORDER = [
    "愿景与设计", "内核与协议", "资源与数据", "前端与安全", "治理与开源", "决策 ADR",
]
DEFAULT_CATEGORY = "愿景与设计"

TITLE_RE = re.compile(r"^#\s+(.+?)\s*$")


def first_title(text):
    for line in text.splitlines():
        m = TITLE_RE.match(line)
        if m:
            return m.group(1).strip()
    return ""


def status_of(text):
    for line in text.splitlines()[:5]:
        if "> 状态:" in line:
            value = line.split("> 状态:", 1)[1].strip()
            # 取第一段（如 "draft"），去掉后面 · 分隔的归属/日期/里程碑
            return value.split("·", 1)[0].strip()
    return "draft"


def entry(md_path, category):
    text = md_path.read_text(encoding="utf-8")
    rel = "../" + md_path.relative_to(docs_dir).as_posix()  # docs/site/ → ../XXX.md
    return {
        "title": first_title(text) or md_path.stem,
        "path": rel,
        "category": category,
        "status": status_of(text),
    }


entries = []
# docs/*.md（顶层，不含 site/ 下的 .md——本目录刻意不放 .md）
# README.md 是导航页自身，不作为文档条目收录
for md in sorted(docs_dir.glob("*.md")):
    if md.name == "README.md":
        continue
    cat = CATEGORY.get(md.name)
    if cat is None:
        print("build-index: WARN 未映射文档，归入默认类: %s" % md.name, file=sys.stderr)
        cat = DEFAULT_CATEGORY
    entries.append(entry(md, cat))

# docs/DECISIONS/*.md → 决策 ADR
decisions_dir = docs_dir / "DECISIONS"
if decisions_dir.is_dir():
    for md in sorted(decisions_dir.glob("*.md")):
        entries.append(entry(md, "决策 ADR"))

if len(entries) < 1:
    print("build-index: 未扫描到任何文档", file=sys.stderr)
    sys.exit(1)

# 稳定排序：分类优先级 → 路径，保证重复生成字节一致
order = {name: i for i, name in enumerate(CATEGORY_ORDER)}
entries.sort(key=lambda e: (order.get(e["category"], 99), e["path"]))

payload = json.dumps(entries, ensure_ascii=False, indent=2)
header = (
    "// 由 docs/site/build-index.sh 自动生成，请勿手改。\n"
    "// 运行 bash docs/site/build-index.sh 重建。断网 file:// 直接可开，零 fetch。\n"
)
site_dir.mkdir(parents=True, exist_ok=True)
out_path.write_text(header + "window.KORE_DOCS = " + payload + ";\n", encoding="utf-8")
print("build-index: 生成 %s（%d 条，分类 %d 个）" % (
    out_path.relative_to(root).as_posix(), len(entries),
    len({e["category"] for e in entries}),
))
PY
