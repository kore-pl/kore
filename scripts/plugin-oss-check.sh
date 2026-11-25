#!/usr/bin/env bash
# kore 插件仓 / 索引仓开源资产校验（G-26 跨仓）
#
# 用法: bash scripts/plugin-oss-check.sh [repo-dir ...]
#   无参数 = 扫描 ../kore-plugin-* 与 ../kore-plugins；无兄弟仓时 [SKIP] 并 exit 0。
#
# 逐仓检查：九件套存在 / LICENSE 与 kore/LICENSE 一致且含 MIT 特征串 /
# YAML 可解析 / README 含 oss 标记块且块内有 CONTRIBUTING+SECURITY 链接 /
# 生成文件无 {{ 残留与 TODO / 插件 info.json.id 与目录名一致 / 索引 JSON 可解析 /
# GitHub ci.yml 只含 workflow_dispatch（绝不自动触发），Gitea ci.yml 含 push tags + workflow_dispatch。
# 不联网、不调用 git、不修改任何文件。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'USAGE'
用法: bash scripts/plugin-oss-check.sh [repo-dir ...]

  无参数    扫描 ../kore-plugin-* 与 ../kore-plugins
  repo-dir  指定要校验的仓库目录，可多个
  --help    打印本帮助

退出码: 0 无 FAIL（可含 WARN）；1 有 FAIL；2 参数错误。
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
  for d in "$ROOT"/../kore-plugin-* "$ROOT"/../kore-plugins; do
    if [ -d "$d" ]; then REPOS+=("$d"); fi
  done
  shopt -u nullglob
  if [ "${#REPOS[@]}" -eq 0 ]; then
    echo "[SKIP] 无兄弟仓"
    exit 0
  fi
fi

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
  ".gitea/workflows/ci.yml"
)

N_PASS=0
N_WARN=0
N_FAIL=0
ROWS=()

HAVE_PY=0
if command -v python3 >/dev/null 2>&1; then HAVE_PY=1; fi

YAML_MODE="grep"
if [ "$HAVE_PY" -eq 1 ] && python3 -c 'import yaml' >/dev/null 2>&1; then
  YAML_MODE="python"
elif command -v ruby >/dev/null 2>&1 && ruby -ryaml -e 'exit 0' >/dev/null 2>&1; then
  YAML_MODE="ruby"
else
  echo "[WARN] 无 pyyaml 也无 ruby，YAML 校验降级为结构 grep"
fi

yaml_ok() { # <file>
  local f="$1"
  case "$YAML_MODE" in
    python)
      python3 -c 'import sys, yaml; d = yaml.safe_load(open(sys.argv[1], encoding="utf-8")); sys.exit(0 if isinstance(d, dict) else 3)' "$f" >/dev/null 2>&1
      ;;
    ruby)
      ruby -ryaml -e 'YAML.load_file(ARGV[0])' "$f" >/dev/null 2>&1
      ;;
    *)
      case "$(basename "$f")" in
        ci.yml) grep -q '^name:' "$f" && grep -q '^jobs:' "$f" ;;
        config.yml) grep -q '^blank_issues_enabled:' "$f" ;;
        *) grep -q '^name:' "$f" && grep -q '^body:' "$f" ;;
      esac
      ;;
  esac
}

for raw in "${REPOS[@]}"; do
  if [ ! -d "$raw" ]; then
    echo "[FAIL] 不是目录: $raw"
    N_FAIL=$((N_FAIL + 1))
    ROWS+=("$(basename "$raw")|FAIL|不是目录")
    continue
  fi
  repo="$(cd "$raw" && pwd)"
  name="$(basename "$repo")"

  if [ "$name" = "kore-plugins" ]; then
    rtype="index"
  elif [[ "$name" == kore-plugin-* ]]; then
    rtype="plugin"
  else
    echo "[WARN] $name 不是 kore-plugin-* 或 kore-plugins，跳过"
    N_WARN=$((N_WARN + 1))
    ROWS+=("$name|SKIP|未知仓库类型")
    continue
  fi

  repo_fail=0
  repo_warn=0
  problems=()

  bad() { repo_fail=$((repo_fail + 1)); problems+=("$1"); echo "[FAIL] $name: $1"; }
  warn() { repo_warn=$((repo_warn + 1)); problems+=("$1"); echo "[WARN] $name: $1"; }

  # 1) 九件套
  for rel in "${FILES[@]}"; do
    if [ ! -f "$repo/$rel" ]; then bad "缺 $rel"; fi
  done

  # 2) LICENSE：与 kore 根逐字一致 + MIT 特征串
  if [ ! -f "$repo/LICENSE" ]; then
    bad "缺 LICENSE"
  else
    if [ -f "$ROOT/LICENSE" ] && ! cmp -s "$repo/LICENSE" "$ROOT/LICENSE"; then
      bad "LICENSE 与 kore/LICENSE 不一致（MIT 全文应逐字相同）"
    fi
    if ! grep -qF 'MIT License' "$repo/LICENSE"; then bad "LICENSE 缺 'MIT License'"; fi
    if ! grep -qF 'Permission is hereby granted' "$repo/LICENSE"; then
      bad "LICENSE 缺 'Permission is hereby granted'"
    fi
  fi

  # 3) YAML 可解析
  yaml_seen=0
  for yml in "$repo"/.github/workflows/*.yml "$repo"/.github/workflows/*.yaml \
             "$repo"/.github/ISSUE_TEMPLATE/*.yml "$repo"/.github/ISSUE_TEMPLATE/*.yaml; do
    if [ ! -f "$yml" ]; then continue; fi
    yaml_seen=$((yaml_seen + 1))
    if ! yaml_ok "$yml"; then
      if [ "$YAML_MODE" = "grep" ]; then
        warn "YAML 结构 grep 未匹配: ${yml#"$repo"/}"
      else
        bad "YAML 解析失败: ${yml#"$repo"/}"
      fi
    fi
  done
  if [ "$yaml_seen" -eq 0 ]; then warn "未找到任何 .github YAML"; fi

  # 4) README oss 标记块
  readme="$repo/README.md"
  if [ ! -f "$readme" ]; then
    bad "缺 README.md"
  else
    has_begin=0
    has_end=0
    if grep -qF '<!-- oss:begin -->' "$readme"; then has_begin=1; fi
    if grep -qF '<!-- oss:end -->' "$readme"; then has_end=1; fi
    if [ "$has_begin" -eq 0 ] || [ "$has_end" -eq 0 ]; then
      bad "README 缺 oss 标记块（oss:begin / oss:end）"
    else
      block="$(awk '/<!-- oss:begin -->/ { f = 1 } f { print } /<!-- oss:end -->/ { f = 0 }' "$readme")"
      if ! grep -qF 'CONTRIBUTING.md' <<< "$block"; then
        bad "README oss 块缺 CONTRIBUTING.md 链接"
      fi
      if ! grep -qF 'SECURITY.md' <<< "$block"; then
        bad "README oss 块缺 SECURITY.md 链接"
      fi
      # 只校验标记块内部：块外的 README 正文是仓库自有内容（如 docker 的 {{.Names}}）。
      stale="$(grep -nF '{{' <<< "$block" | grep -vF '${{' || true)"
      if [ -n "$stale" ]; then bad "README oss 块残留占位符 {{"; fi
    fi
  fi

  # 5) 生成文件：占位残留 / TODO
  for rel in "${FILES[@]}"; do
    f="$repo/$rel"
    if [ ! -f "$f" ]; then continue; fi
    stale="$(grep -nF '{{' "$f" | grep -vF '${{' || true)"
    if [ -n "$stale" ]; then bad "$rel 残留占位符 {{"; fi
    todos="$(grep -nE 'TODO|待补充|待定' "$f" || true)"
    if [ -n "$todos" ]; then bad "$rel 含 TODO/待补充/待定"; fi
  done

  # 6) CI 触发口径（2026-11-25 用户裁决）：GitHub 只 workflow_dispatch（绝不自动触发）；
  #    Gitea = push tags + workflow_dispatch（版本触发）。
  ci_file="$repo/.github/workflows/ci.yml"
  if [ -f "$ci_file" ]; then
    if ! grep -q 'workflow_dispatch' "$ci_file"; then
      bad "GitHub ci.yml 缺 workflow_dispatch（手动触发）"
    fi
    if grep -qE '^[[:space:]]*(push|pull_request):' "$ci_file"; then
      bad "GitHub ci.yml 含 push:/pull_request: 自动触发（只允许 workflow_dispatch）"
    fi
  fi
  gitea_ci="$repo/.gitea/workflows/ci.yml"
  if [ -f "$gitea_ci" ]; then
    if ! grep -q 'workflow_dispatch' "$gitea_ci"; then
      bad "Gitea ci.yml 缺 workflow_dispatch（手动触发）"
    fi
    if ! grep -q 'tags:' "$gitea_ci"; then
      bad "Gitea ci.yml 缺 push tags（版本触发）"
    fi
  fi

  # 7) 类型专属
  if [ "$rtype" = "plugin" ]; then
    suffix="${name#kore-plugin-}"
    info="$repo/info.json"
    if [ ! -f "$info" ]; then
      bad "缺 info.json"
    elif [ "$HAVE_PY" -eq 1 ]; then
      pid="$(python3 -c 'import json, sys
try:
    print(json.load(open(sys.argv[1], encoding="utf-8")).get("id", ""))
except Exception:
    sys.exit(3)' "$info" 2>/dev/null)" || pid=""
      if [ -z "$pid" ]; then
        bad "info.json 解析失败或缺 id"
      elif [ "$pid" != "$suffix" ]; then
        bad "info.json.id=$pid 与目录后缀 $suffix 不一致"
      fi
    else
      warn "无 python3，跳过 info.json.id 校验"
    fi
  else
    idx="$repo/index/plugins.json"
    if [ ! -f "$idx" ]; then
      bad "缺 index/plugins.json"
    elif [ "$HAVE_PY" -eq 1 ]; then
      if ! python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$idx" >/dev/null 2>&1; then
        bad "index/plugins.json 无法被 python3 json 解析"
      fi
    else
      warn "无 python3，跳过 index/plugins.json 解析校验"
    fi
    if [ ! -f "$repo/index/plugins.json.sig" ]; then
      warn "缺 index/plugins.json.sig（索引签名）"
    fi
  fi

  if [ "$repo_fail" -gt 0 ]; then
    result="FAIL"
    N_FAIL=$((N_FAIL + 1))
  elif [ "$repo_warn" -gt 0 ]; then
    result="WARN"
    N_WARN=$((N_WARN + 1))
  else
    result="PASS"
    N_PASS=$((N_PASS + 1))
  fi

  detail="—"
  if [ "${#problems[@]}" -gt 0 ]; then
    detail="$(printf '%s；' "${problems[@]}")"
    detail="${detail%；}"
  fi
  ROWS+=("$name|$result|$detail")

  unset -f bad warn
done

echo ""
echo "检查范围: 九件套 + Gitea CI + README 开源段（GitHub 只手动触发；Gitea 按版本 tag + 手动）"
echo "per-repo 结果："
printf '%-32s %-6s %s\n' "REPO" "结果" "缺失项 / 问题"
for row in "${ROWS[@]}"; do
  IFS='|' read -r r s m <<< "$row"
  printf '%-32s %-6s %s\n' "$r" "$s" "$m"
done

echo ""
echo "汇总: ${N_PASS} pass / ${N_WARN} warn / ${N_FAIL} fail"
if [ "$N_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
