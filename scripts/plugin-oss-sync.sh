#!/usr/bin/env bash
# kore 插件仓 / 索引仓开源资产同步（幂等）
#
# 用法: bash scripts/plugin-oss-sync.sh [--check|--dry-run] [repo-dir ...]
#   --check    只报告差异：逐项打印，有差异 exit 1
#   --dry-run  只打印将写哪些文件，不落盘
#   repo-dir   指定仓库目录；默认扫描 ../kore-plugin-* 与 ../kore-plugins
#
# 只写九件套（CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / AGENTS /
# .github/PULL_REQUEST_TEMPLATE.md / .github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml /
# .github/workflows/ci.yml）与 README 的 <!-- oss:begin -->…<!-- oss:end --> 块；
# CI 与 kore 同一策略：25 仓都配 CI 但少触发（push main + tag v* + PR + 手动）。
# 不碰 LICENSE / CHANGELOG.md / info.json / manifest.json / Makefile。
# 不联网、不调用 git、不提交；同一输入重复运行必须 0 变更。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TPL="$ROOT/scripts/plugin-templates"
YEAR="2026"

MODE="apply"
REPOS=()
DIFF_TOTAL=0
FAILED=0

usage() {
  cat <<'USAGE'
用法: bash scripts/plugin-oss-sync.sh [--check|--dry-run] [repo-dir ...]

  （无参数）   扫描 ../kore-plugin-* 与 ../kore-plugins 并写入
  --check      只报告差异：逐项打印，有差异 exit 1
  --dry-run    只打印将写哪些文件，不落盘
  repo-dir     指定仓库目录，可多个
  --help       打印本帮助

退出码: 0 全部一致 / 写入成功；1 有差异（--check）或取值失败；2 参数错误。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --dry-run) MODE="dryrun"; shift ;;
    --help|-h) usage; exit 0 ;;
    --*) echo "[FAIL] 未知参数: $1" >&2; usage >&2; exit 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

command -v python3 >/dev/null 2>&1 || {
  echo "[FAIL] 需要 python3（解析 info.json / go.mod 并渲染模板）" >&2
  exit 1
}

if [ "${#REPOS[@]}" -eq 0 ]; then
  shopt -s nullglob
  for d in "$ROOT"/../kore-plugin-* "$ROOT"/../kore-plugins; do
    if [ -d "$d" ]; then REPOS+=("$d"); fi
  done
  shopt -u nullglob
  if [ "${#REPOS[@]}" -eq 0 ]; then
    echo "[SKIP] 无兄弟仓（$ROOT/.. 下没有 kore-plugin-* / kore-plugins）"
    exit 0
  fi
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/kore-plugin-oss-sync.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

FILES=(
  "CONTRIBUTING.md"
  "SECURITY.md"
  "CODE_OF_CONDUCT.md"
  "AGENTS.md"
  ".github/PULL_REQUEST_TEMPLATE.md"
  ".github/ISSUE_TEMPLATE/bug_report.yml"
  ".github/ISSUE_TEMPLATE/feature_request.yml"
  ".github/ISSUE_TEMPLATE/config.yml"
  ".github/workflows/ci.yml"
)

# 模板渲染后不允许残留 {{...}}（${{ ... }} 属 GitHub 表达式，排除）。
has_stale_placeholder() {
  grep -nF '{{' "$1" 2>/dev/null | grep -vF '${{' >/dev/null 2>&1
}

# 从 info.json / go.mod / 目录名取值；缺字段直接 exit 非 0，由调用方记 FAIL。
read_values() {
  python3 - "$1" "$2" "$3" "$YEAR" <<'PY'
import json, os, sys

info_path, gomod, repo, year = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
required = ("id", "name", "version", "protocol", "lifecycle",
            "depth_level", "entry", "requires_kore")
try:
    with open(info_path, encoding="utf-8") as f:
        info = json.load(f)
except Exception as exc:
    sys.exit("[FAIL] info.json 解析失败: %s" % exc)
missing = [k for k in required
           if not isinstance(info.get(k), str) or not info[k].strip()]
if missing:
    sys.exit("[FAIL] info.json 缺少字段: " + ", ".join(missing))
if not os.path.isfile(gomod):
    sys.exit("[FAIL] 缺少 go.mod")
module = ""
with open(gomod, encoding="utf-8") as f:
    for line in f:
        s = line.strip()
        if s.startswith("module "):
            module = s.split(None, 1)[1].strip()
            break
if not module:
    sys.exit("[FAIL] go.mod 缺少 module 行")
vals = {
    "ID": info["id"],
    "NAME": info["name"],
    "MODULE": module,
    "VERSION": info["version"],
    "REQUIRES_KORE": info["requires_kore"],
    "PROTOCOL": info["protocol"],
    "LIFECYCLE": info["lifecycle"],
    "DEPTH": info["depth_level"],
    "BIN": os.path.basename(info["entry"].rstrip("/")),
    "ENTRY": info["entry"],
    "REPO": repo,
    "REPO_URL": "https://github.com/kore-pl/" + repo,
    "YEAR": year,
}
for key in ("ID", "NAME", "MODULE", "VERSION", "REQUIRES_KORE", "PROTOCOL",
            "LIFECYCLE", "DEPTH", "BIN", "ENTRY", "REPO", "REPO_URL", "YEAR"):
    print("%s\t%s" % (key, vals[key]))
PY
}

render() { # render <tpl> <out> KEY=VALUE...
  python3 - "$@" <<'PY'
import sys

tpl, out = sys.argv[1], sys.argv[2]
mapping = {}
for pair in sys.argv[3:]:
    key, _, value = pair.partition("=")
    mapping[key] = value
with open(tpl, encoding="utf-8") as f:
    text = f.read()
for key, value in mapping.items():
    text = text.replace("{{" + key + "}}", value)
with open(out, "w", encoding="utf-8", newline="") as f:
    f.write(text)
PY
}

# README 处理：0 = 需要写入（$3 已生成），1 = 已一致，2 = 标记不成对。
prepare_readme() { # <repo> <block-file> <out>
  local repo="$1" block="$2" out="$3" readme="$1/README.md"
  local has_begin=0 has_end=0
  if [ -f "$readme" ]; then
    if grep -qF '<!-- oss:begin -->' "$readme"; then has_begin=1; fi
    if grep -qF '<!-- oss:end -->' "$readme"; then has_end=1; fi
  fi
  if [ "$has_begin" -eq 1 ] && [ "$has_end" -eq 1 ]; then
    awk -v blockfile="$block" '
      BEGIN { while ((getline line < blockfile) > 0) blk = blk line "\n" }
      /<!-- oss:begin -->/ { printf "%s", blk; skip = 1; next }
      /<!-- oss:end -->/ { skip = 0; next }
      skip != 1 { print }
    ' "$readme" > "$out" || return 2
  elif [ "$has_begin" -eq 1 ] || [ "$has_end" -eq 1 ]; then
    return 2
  elif [ ! -f "$readme" ]; then
    cp "$block" "$out"
  else
    cp "$readme" "$out"
    # 补齐换行，再保证块前恰好一个空行。
    if [ -s "$out" ] && [ "$(tail -c1 "$out" | wc -l | tr -d ' ')" -eq 0 ]; then
      printf '\n' >> "$out"
    fi
    if [ -s "$out" ] && [ -n "$(tail -n1 "$out")" ]; then
      printf '\n' >> "$out"
    fi
    cat "$block" >> "$out"
  fi
  if [ -f "$readme" ] && cmp -s "$readme" "$out"; then return 1; fi
  return 0
}

for raw in "${REPOS[@]}"; do
  if [ ! -d "$raw" ]; then
    echo "[FAIL] 不是目录: $raw"
    FAILED=$((FAILED + 1))
    continue
  fi
  repo="$(cd "$raw" && pwd)"
  repo_name="$(basename "$repo")"

  if [ "$repo_name" = "kore-plugins" ]; then
    template_dir="$TPL/index-repo"
  elif [[ "$repo_name" == kore-plugin-* ]] && [ -f "$repo/info.json" ]; then
    template_dir="$TPL/plugin-repo"
  elif [[ "$repo_name" == kore-plugin-* ]]; then
    echo "[SKIP] $repo_name 缺少 info.json，无法判定插件仓库"
    continue
  else
    echo "[SKIP] $repo_name 不是 kore-plugin-* 或 kore-plugins"
    continue
  fi

  declare -A VALS=()
  if [ "$template_dir" = "$TPL/plugin-repo" ]; then
    if ! vals="$(read_values "$repo/info.json" "$repo/go.mod" "$repo_name")"; then
      echo "[FAIL] $repo_name 取值失败，跳过"
      FAILED=$((FAILED + 1))
      continue
    fi
  else
    vals="$(printf 'REPO\t%s\nREPO_URL\thttps://github.com/kore-pl/%s\nYEAR\t%s\n' \
      "$repo_name" "$repo_name" "$YEAR")"
  fi
  while IFS=$'\t' read -r key value; do
    if [ -n "$key" ]; then VALS["$key"]="$value"; fi
  done <<< "$vals"

  ARGS=()
  for key in ID NAME MODULE VERSION REQUIRES_KORE PROTOCOL LIFECYCLE DEPTH BIN ENTRY REPO REPO_URL YEAR; do
    if [ -n "${VALS[$key]+x}" ]; then ARGS+=("$key=${VALS[$key]}"); fi
  done

  changed=0
  repo_bad=0

  for rel in "${FILES[@]}"; do
    tpl="$template_dir/$rel"
    if [ ! -f "$tpl" ]; then
      echo "[FAIL] $repo_name 缺模板: $tpl"
      FAILED=$((FAILED + 1))
      repo_bad=1
      continue
    fi
    out="$TMP/out"
    render "$tpl" "$out" "${ARGS[@]}"
    if has_stale_placeholder "$out"; then
      echo "[FAIL] $repo_name: $rel 渲染后仍残留占位符"
      FAILED=$((FAILED + 1))
      repo_bad=1
      continue
    fi
    target="$repo/$rel"
    if [ -f "$target" ] && cmp -s "$out" "$target"; then
      continue
    fi
    changed=$((changed + 1))
    case "$MODE" in
      check) echo "  diff: $repo_name/$rel" ;;
      dryrun) echo "  would write: $repo_name/$rel" ;;
      apply)
        mkdir -p "$(dirname "$target")"
        cp "$out" "$target"
        ;;
    esac
  done

  # README 只管理标记块内部/追加块。
  block="$TMP/readme-block"
  render "$template_dir/README-oss-block.md" "$block" "${ARGS[@]}"
  if has_stale_placeholder "$block"; then
    echo "[FAIL] $repo_name: README 段渲染后仍残留占位符"
    FAILED=$((FAILED + 1))
    repo_bad=1
  else
    readme_out="$TMP/readme.next"
    rc=0
    prepare_readme "$repo" "$block" "$readme_out" || rc=$?
    if [ "$rc" -eq 2 ]; then
      echo "[FAIL] $repo_name: README 的 oss 标记不成对（oss:begin / oss:end 必须同时存在）"
      FAILED=$((FAILED + 1))
      repo_bad=1
    elif [ "$rc" -eq 0 ]; then
      changed=$((changed + 1))
      case "$MODE" in
        check) echo "  diff: $repo_name/README.md" ;;
        dryrun) echo "  would write: $repo_name/README.md" ;;
        apply) cp "$readme_out" "$repo/README.md" ;;
      esac
    fi
  fi

  if [ "$repo_bad" -eq 1 ]; then
    echo "[FAIL] $repo_name 未完成同步（见上方错误）"
    continue
  fi
  if [ "$changed" -eq 0 ]; then
    echo "[OK] $repo_name files=9 changed=0"
  else
    DIFF_TOTAL=$((DIFF_TOTAL + 1))
    if [ "$MODE" = "check" ]; then
      echo "[DIFF] $repo_name files=9 changed=$changed"
    elif [ "$MODE" = "dryrun" ]; then
      echo "[DIFF] $repo_name files=9 changed=$changed（dry-run，未落盘）"
    else
      echo "[DIFF] $repo_name files=9 changed=$changed（已写入）"
    fi
  fi
done

if [ "$FAILED" -gt 0 ]; then
  echo "[FAIL] $FAILED 个仓库取值/模板/标记异常"
  exit 1
fi
if [ "$MODE" = "check" ] && [ "$DIFF_TOTAL" -gt 0 ]; then
  exit 1
fi
exit 0
