#!/usr/bin/env bash
# gitee-release-prune.sh — Gitee 发行版保留策略
#
# 只保留最新 N 个 release（按 created_at 倒序），其余先删附件再删 release。
# Gitee release 是镜像产物；GitHub 侧全量保留，本脚本只作用于 Gitee。
#
# 用法:
#   scripts/gitee-release-prune.sh [--dry-run] [--keep N] [--repo owner/name]...
#
#   --dry-run        只打印计划，不删除
#   --keep N         保留数量，默认 5（>=1）
#   --repo owner/name 指定仓库，可重复；缺省从当前目录的 gitee / origin remote 推断
#
# 凭据: 环境变量 GITEE_TOKEN（必填）。禁止把 token 写进本文件或提交历史（G-30）。
# 退出码: 0 成功；1 任一仓库失败。
set -uo pipefail

API_BASE="${GITEE_API_BASE:-https://gitee.com/api/v5}"
KEEP=5
DRY_RUN=0
REPOS=()

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --keep)    [ $# -ge 2 ] || die "--keep 需要参数"; KEEP="$2"; shift 2 ;;
    --repo)    [ $# -ge 2 ] || die "--repo 需要参数"; REPOS+=("$2"); shift 2 ;;
    -h|--help) usage 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) die "--keep 必须是正整数（当前 '$KEEP'）" ;;
esac
[ "$KEEP" -ge 1 ] || die "--keep 必须 >= 1"

[ -n "${GITEE_TOKEN:-}" ] || die "GITEE_TOKEN 未设置（export GITEE_TOKEN=... 后再跑）"

# 从 git remote URL 解析 owner/repo
parse_repo() {
  local u="$1" out=""
  u="${u%.git}"
  if [[ "$u" == *"gitee.com/"* ]]; then
    out="${u##*gitee.com/}"
  elif [[ "$u" == *"gitee.com:"* ]]; then
    out="${u##*gitee.com:}"
  fi
  printf '%s' "$out"
}

infer_repo() {
  local u
  u="$(git remote get-url gitee 2>/dev/null || true)"
  [ -n "$u" ] || u="$(git remote get-url origin 2>/dev/null || true)"
  [ -n "$u" ] || die "无法从当前目录推断仓库，请用 --repo owner/name"
  local r; r="$(parse_repo "$u")"
  [ -n "$r" ] || die "remote URL 不是 gitee 地址: $u"
  printf '%s' "$r"
}

# HTTP 辅助：只输出 body，状态码写到 /tmp 临时文件
api() {
  local method="$1" path="$2" out="$3"
  local url="$API_BASE$path"
  if [[ "$url" == *"?"* ]]; then url="$url&access_token=${GITEE_TOKEN}"; else url="$url?access_token=${GITEE_TOKEN}"; fi
  curl -sS --max-time 120 -X "$method" "$url" -o "$out" -w '%{http_code}'
}

api_get() {  # $1=path $2=outfile ; prints http code
  api GET "$1" "$2"
}

list_releases() {  # $1=owner/repo $2=outfile ; prints count
  local repo="$1" out="$2" page=1 total=0
  : > "$out"
  while :; do
    local tmp; tmp="$(mktemp)"
    local code; code="$(curl -sS --max-time 120 \
      "$API_BASE/repos/$repo/releases?access_token=${GITEE_TOKEN}&page=$page&per_page=100" \
      -o "$tmp" -w '%{http_code}')"
    if [ "$code" != "200" ]; then rm -f "$tmp"; return 1; fi
    local n; n="$(jq 'length' "$tmp" 2>/dev/null || echo 0)"
    if [ "$n" = "0" ]; then rm -f "$tmp"; break; fi
    jq -c '.[]' "$tmp" >> "$out"
    total=$((total + n))
    rm -f "$tmp"
    [ "$n" -lt 100 ] && break
    page=$((page + 1))
  done
  printf '%s' "$total"
}

prune_repo() {
  local repo="$1"
  local tmp; tmp="$(mktemp)"
  local total
  total="$(list_releases "$repo" "$tmp")" || { printf '[FAIL] %s: 拉取 release 列表失败\n' "$repo"; rm -f "$tmp"; return 1; }

  printf '\n== %s ==\n' "$repo"
  printf '   release 总数: %s，保留最新 %s 个\n' "$total" "$KEEP"
  if [ "$total" -le "$KEEP" ]; then
    printf '   [%s] 无需清理\n' "$([ "$DRY_RUN" = 1 ] && echo DRY-RUN || echo OK)"
    rm -f "$tmp"; return 0
  fi

  # 倒序：最新在前，前 KEEP 个保留
  local victims; victims="$(jq -s -r 'sort_by(.created_at) | reverse | .[] | [.id, .tag_name] | @tsv' "$tmp" | tail -n +$((KEEP + 1)))"
  local rc=0
  while IFS=$'\t' read -r rid tag; do
    [ -n "$rid" ] || continue
    local afile; afile="$(mktemp)"
    local acode; acode="$(api_get "/repos/$repo/releases/$rid/attach_files" "$afile")"
    local an=0
    [ "$acode" = "200" ] && an="$(jq 'length' "$afile" 2>/dev/null || echo 0)"
    printf '   - 删除 %s（release id=%s，附件 %s 个）\n' "$tag" "$rid" "$an"
    if [ "$DRY_RUN" = 1 ]; then rm -f "$afile"; continue; fi
    if [ "$acode" = "200" ]; then
      while IFS= read -r fid; do
        [ -n "$fid" ] || continue
        local dcode; dcode="$(api DELETE "/repos/$repo/releases/$rid/attach_files/$fid" /dev/null)"
        [ "$dcode" = "200" ] || [ "$dcode" = "204" ] || { printf '     [WARN] 附件 %s 删除失败 http=%s\n' "$fid" "$dcode"; }
      done < <(jq -r '.[].id' "$afile" 2>/dev/null)
    fi
    rm -f "$afile"
    local rcode; rcode="$(api DELETE "/repos/$repo/releases/$rid" /dev/null)"
    [ "$rcode" = "200" ] || [ "$rcode" = "204" ] || { printf '     [FAIL] release %s 删除失败 http=%s\n' "$rid" "$rcode"; rc=1; }
  done <<< "$victims"

  rm -f "$tmp"
  if [ "$DRY_RUN" = 0 ]; then
    local after; after="$(mktemp)"
    local n; n="$(list_releases "$repo" "$after")" || n="?"
    printf '   清理后 release 数: %s\n' "$n"
    [ "$n" = "$KEEP" ] || { printf '   [FAIL] 清理后数量不等于 %s\n' "$KEEP"; rc=1; }
    rm -f "$after"
  fi
  return "$rc"
}

[ "${#REPOS[@]}" -gt 0 ] || REPOS=("$(infer_repo)")

FAILED=0
for r in "${REPOS[@]}"; do
  [[ "$r" == */* ]] || { printf '[FAIL] 仓库格式应为 owner/name: %s\n' "$r"; FAILED=1; continue; }
  prune_repo "$r" || FAILED=1
done

[ "$FAILED" = 0 ] || { printf '\n[FAIL] 存在失败项，见上方输出\n' >&2; exit 1; }
printf '\n[DONE] 全部完成%s\n' "$([ "$DRY_RUN" = 1 ] && echo '（dry-run，未删除）' || echo '')"
