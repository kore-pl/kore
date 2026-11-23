#!/usr/bin/env bash
# kore 插件仓规范门禁（G-17）
#
# 用法: bash scripts/store-check.sh [repo-dir ...]
#   无参数 = 扫描 ../kore-plugin-*；无兄弟仓时 [SKIP] 并 exit 0。
#
# 逐仓检查（判据来源 G-17 / G-27，不改判据、不为变绿放宽）：
#   1) 三件套：info.json / Makefile 内含 dist 目标 / CHANGELOG.md
#   2) info.json 必填 10 字段：id version description depends_on conflicts
#      scenario_tags size_bytes requires_kore depth_level capabilities
#   3) id 匹配 ^[a-z][a-z0-9-]*$ 且等于目录名后缀 kore-plugin-<id>
#   4) info.json.version == manifest.json.version（manifest 存在时）
#   5) go.mod 的 replace 只拦 `=> ../` 与绝对路径（`=> ./` 允许，G-17 原文）
#
# 失败逐条指名到「仓 + 文件 + 字段」，不做汇总掩盖。
# 不联网、不调用 git、不修改任何文件。退出码: 0 全过；1 有 FAIL；2 参数错误。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
用法: bash scripts/store-check.sh [repo-dir ...]

  无参数    扫描 ../kore-plugin-*
  repo-dir  指定要校验的插件仓目录，可多个
  --help    打印本帮助

退出码: 0 无 FAIL；1 有 FAIL；2 参数错误。
USAGE
}

REPOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --*) echo "[FAIL] 未知参数: $1" >&2; usage >&2; exit 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

if [ "${#REPOS[@]}" -eq 0 ]; then
  shopt -s nullglob
  for d in "$ROOT"/../kore-plugin-*; do
    if [ -d "$d" ]; then REPOS+=("$d"); fi
  done
  shopt -u nullglob
  if [ "${#REPOS[@]}" -eq 0 ]; then
    echo "[SKIP] 无兄弟插件仓（../kore-plugin-*），G-17 校验跳过"
    exit 0
  fi
fi

# JSON 解析不做 grep 降级：字段级判据靠猜等于没判据。
if ! command -v python3 >/dev/null 2>&1; then
  echo "[FAIL] 需要 python3 解析 info.json / manifest.json（门禁不降级为 grep 猜测）"
  exit 1
fi

python3 - "${REPOS[@]}" <<'PY'
import json
import os
import re
import sys

# G-17 三件套 + 必填字段（判据原文，不得增删）
REQ_FIELDS = [
    "id", "version", "description", "depends_on", "conflicts",
    "scenario_tags", "size_bytes", "requires_kore", "depth_level", "capabilities",
]
ID_RE = re.compile(r"^[a-z][a-z0-9-]*$")
DIST_RE = re.compile(r"^dist\s*:", re.M)
PREFIX = "kore-plugin-"

n_pass = 0
n_fail = 0

def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)

for raw in sys.argv[1:]:
    repo = os.path.abspath(raw)
    name = os.path.basename(repo)

    if not os.path.isdir(repo):
        print(f"[FAIL] {name}: 不是目录: {raw}")
        n_fail += 1
        continue

    problems = []

    # 1) 三件套
    info_path = os.path.join(repo, "info.json")
    mk_path = os.path.join(repo, "Makefile")
    cl_path = os.path.join(repo, "CHANGELOG.md")

    if not os.path.isfile(info_path):
        problems.append("缺 info.json")
    if not os.path.isfile(mk_path):
        problems.append("缺 Makefile")
    else:
        with open(mk_path, encoding="utf-8", errors="replace") as fh:
            mk_text = fh.read()
        if not DIST_RE.search(mk_text):
            problems.append("Makefile 缺 dist 目标")
    if not os.path.isfile(cl_path):
        problems.append("缺 CHANGELOG.md")

    # 2)~4) info.json 必填字段 / id / 版本一致
    info = None
    if os.path.isfile(info_path):
        try:
            info = load_json(info_path)
        except Exception as exc:  # noqa: BLE001 - 解析失败要原样透出
            problems.append(f"info.json 解析失败: {exc}")
        if info is not None and not isinstance(info, dict):
            problems.append("info.json 顶层不是 JSON 对象")
            info = None

    if isinstance(info, dict):
        for field in REQ_FIELDS:
            if field not in info:
                problems.append(f"info.json 缺必填字段 {field}")

        pid = info.get("id")
        if isinstance(pid, str):
            if not ID_RE.match(pid):
                problems.append(f"info.json.id={pid} 不匹配 ^[a-z][a-z0-9-]*$（G-27）")
            if not name.startswith(PREFIX):
                problems.append(f"目录名 {name} 非 {PREFIX}<id> 形态（G-27）")
            else:
                suffix = name[len(PREFIX):]
                if pid != suffix:
                    problems.append(f"info.json.id={pid} ≠ 目录名后缀 {suffix}（G-27）")
        elif "id" in info:
            problems.append("info.json.id 不是字符串")

        manifest_path = os.path.join(repo, "manifest.json")
        if os.path.isfile(manifest_path):
            try:
                manifest = load_json(manifest_path)
            except Exception as exc:  # noqa: BLE001
                problems.append(f"manifest.json 解析失败: {exc}")
                manifest = None
            if isinstance(manifest, dict):
                iv = info.get("version")
                mv = manifest.get("version")
                if iv != mv:
                    problems.append(
                        f"版本不一致: info.json.version={iv} ≠ manifest.json.version={mv}"
                    )

    # 5) go.mod replace：只拦跨仓 / 绝对路径（`=> ./` 是 Go 标准做法，放行）
    gomod_path = os.path.join(repo, "go.mod")
    if os.path.isfile(gomod_path):
        with open(gomod_path, encoding="utf-8", errors="replace") as fh:
            for lineno, line in enumerate(fh, 1):
                stripped = line.strip()
                if not stripped.startswith("replace ") or "=>" not in stripped:
                    continue
                target = stripped.split("=>", 1)[1].strip()
                if target.startswith("../") or target.startswith("/"):
                    problems.append(
                        f"go.mod:{lineno} 跨仓/绝对路径 replace 禁止提交（只放 go.work）: {stripped}"
                    )

    if problems:
        n_fail += 1
        for item in problems:
            print(f"[FAIL] {name}: {item}")
    else:
        n_pass += 1
        print(f"[OK] {name}")

print("")
print("检查范围: 三件套 + info.json 必填 10 字段 + id/目录一致(G-27) + "
      "info/manifest 版本一致 + go.mod replace 跨仓拦截")
print(f"store-check: {n_pass} pass, {n_fail} fail")
sys.exit(1 if n_fail else 0)
PY
