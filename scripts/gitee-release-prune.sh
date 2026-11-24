#!/usr/bin/env bash
# gitee-release-prune.sh — Gitee 发行版保留策略（按 tag 语义版本判序）
#
# 只保留版本最新的 N 个 release，其余先删附件再删 release。
# 判序依据是 tag 的语义版本（sort -V），**不使用 created_at，也不使用 release id**：
# 补建批次按版本倒序创建，时间序 ≠ 版本序（事故 33088d9：integrity v0.4.0 版本第 2 新却被误删）。
#
# 用法:
#   scripts/gitee-release-prune.sh [--dry-run] [--keep N] [--repo owner/name]...
#
#   --dry-run        只打印判序依据与计划，不删除
#   --keep N         保留数量，默认 5（>=1）
#   --repo owner/name 指定仓库，可重复；缺省从当前目录的 gitee / origin remote 推断
#
# 判序规则:
#   1) 只认 ^v[0-9] 形态的 tag（跳过 pkg/pluginapi/* 等子模块 tag，它们不参与判序）
#   2) 版本号用 GNU version sort（sort -V）排序，0.10.0 排在 0.9.0 之后
#   3) 同版本多前缀（v1.0.0 与 1.0.0 并存）视为歧义 → 整仓跳过并 WARN，绝不猜
#
# 例外清单（显式，设计允许的偏差）:
#   PRUNE_EXCEPTIONS 中的 "<owner>/<repo>:<tag>" 永不删除，命中时打印 [SKIP-EXCEPTION]。
#   仅用于「GitHub 无对应 release、Gitee 为唯一发行物副本」的历史版本；
#   新增 / 移除例外必须同步 docs/GITEE-MIRROR.md §3——禁止写成「GitHub 查不到就跳过」的隐式行为。
#
# 删除护栏（任一条不成立即中止该仓、不删）:
#   ① 删除后剩余数量 == --keep（该仓命中显式例外时：== --keep + 例外数）
#   ② 被删版本全部严格小于保留集最小版本
#
# 凭据: 环境变量 GITEE_TOKEN（必填）。禁止把 token 写进本文件或提交历史（G-30）。
# 退出码: 0 成功（含歧义跳过）；1 任一仓库失败。
set -uo pipefail

API_BASE="${GITEE_API_BASE:-https://gitee.com/api/v5}"
KEEP=5
DRY_RUN=0
REPOS=()
SKIPPED=0

# 显式例外：<owner>/<repo>:<tag>。见 docs/GITEE-MIRROR.md §3「例外（显式清单）」。
PRUNE_EXCEPTIONS=(
  "pengtang1024/kore-plugin-echo:v0.1.0"  # GitHub 只有 tag、无 release；Gitee 是该版本唯一副本
)

usage() {
  sed -n '2,/^set -uo pipefail/p' "$0" | grep -v '^set -uo pipefail' | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

# 显式例外判定：只有清单里逐条登记的 <owner>/<repo>:<tag> 才算例外
is_exception() {  # $1=owner/repo $2=tag
  local e
  for e in "${PRUNE_EXCEPTIONS[@]}"; do
    [ "$e" = "$1:$2" ] && return 0
  done
  return 1
}

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

# 版本比较：$1 严格小于 $2 时返回 0（GNU version sort 语义）
version_lt() {
  local a="$1" b="$2" first
  [ "$a" = "$b" ] && return 1
  first="$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n 1)"
  [ "$first" = "$a" ]
}

prune_repo() {
  local repo="$1"
  local tmp; tmp="$(mktemp)"
  local total
  total="$(list_releases "$repo" "$tmp")" || {
    printf '\n== %s ==\n   [FAIL] 拉取 release 列表失败\n' "$repo"
    rm -f "$tmp"; return 1
  }

  printf '\n== %s ==\n' "$repo"
  printf '   release 总数: %s，保留最新 %s 个\n' "$total" "$KEEP"
  printf '   判序依据: tag 语义版本（sort -V）；不使用 created_at / release id\n'

  # ── 抽取候选 tag，行格式: 版本<TAB>id<TAB>tag ──
  local -a rows=() extra=() alltags=()
  local rid rtag ver unparsed=0
  while IFS=$'\t' read -r rid rtag; do
    [ -n "$rtag" ] || continue
    alltags+=("$rtag")
    case "$rtag" in
      v[0-9]*)      rows+=("${rtag#v}"$'\t'"$rid"$'\t'"$rtag") ;;
      [0-9]*|V[0-9]*) extra+=("${rtag#V}"$'\t'"$rtag") ;;  # 非 v 前缀的版本号候选
      *)            unparsed=$((unparsed + 1)) ;;          # 子模块 tag 等：不参与判序
    esac
  done < <(jq -r '[.id, .tag_name] | @tsv' "$tmp")

  # ── 例外清单校验：本仓登记的例外必须真实存在（防过期 / 拼错）──
  local e erepo etag found t
  for e in "${PRUNE_EXCEPTIONS[@]}"; do
    erepo="${e%%:*}"; etag="${e##*:}"
    [ "$erepo" = "$repo" ] || continue
    found=0
    for t in "${alltags[@]}"; do
      [ "$t" = "$etag" ] && { found=1; break; }
    done
    [ "$found" = 1 ] || printf '   [WARN] 例外清单条目未在本仓 release 中找到：%s（过期或拼错？）\n' "$e"
  done

  # ── 同版本多前缀歧义（v1.0.0 与 1.0.0 并存）→ 不猜，整仓跳过 ──
  local ambig=0 ev etag line
  if [ "${#extra[@]}" -gt 0 ] && [ "${#rows[@]}" -gt 0 ]; then
    local accepted_text; accepted_text="$(printf '%s\n' "${rows[@]}" | cut -f1)"
    for line in "${extra[@]}"; do
      IFS=$'\t' read -r ev etag <<< "$line"
      if printf '%s\n' "$accepted_text" | grep -qxF -- "$ev"; then
        ambig=1
        printf '   [WARN] 同版本多前缀歧义：%s 与同版本 v 前缀 tag 并存\n' "$etag"
      fi
    done
  fi
  if [ "$ambig" = 1 ]; then
    printf '   [WARN] 判序存在歧义，整仓跳过、不做任何删除（人工对齐 tag 命名后重跑）\n'
    SKIPPED=$((SKIPPED + 1))
    rm -f "$tmp"; return 0
  fi

  local ncand="${#rows[@]}"
  [ "$unparsed" -eq 0 ] || \
    printf '   [WARN] %s 条 release 的 tag 不匹配 ^v[0-9]，不参与判序\n' "$unparsed"
  if [ "$ncand" -eq 0 ]; then
    printf '   [%s] 没有可判序（^v[0-9]）的 release，跳过\n' "$([ "$DRY_RUN" = 1 ] && echo DRY-RUN || echo OK)"
    rm -f "$tmp"; return 0
  fi

  # ── 版本升序 ──
  local -a asc=()
  while IFS= read -r line; do
    [ -n "$line" ] && asc+=("$line")
  done < <(printf '%s\n' "${rows[@]}" | sort -V -t$'\t' -k1,1)

  local keepstart=$(( ${#asc[@]} - KEEP + 1 ))
  [ "$keepstart" -ge 1 ] || keepstart=1

  # ── 保留集（按版本序，新→旧） ──
  local -a keep_tags=() keep_vers=()
  local i
  for (( i=${#asc[@]}-1; i>=keepstart-1; i-- )); do
    IFS=$'\t' read -r ver rid rtag <<< "${asc[$i]}"
    keep_tags+=("$rtag"); keep_vers+=("$ver")
  done
  printf '   保留（按版本序，新→旧，%s 个）: %s\n' "${#keep_tags[@]}" "${keep_tags[*]}"

  # ── 待删集（版本序，旧→新；命中显式例外的不删，且必须显式打印） ──
  local -a victims=() excepted=()
  for (( i=0; i<keepstart-1; i++ )); do
    IFS=$'\t' read -r ver rid rtag <<< "${asc[$i]}"
    if is_exception "$repo" "$rtag"; then
      printf '   [SKIP-EXCEPTION] %s %s: GitHub 无对应 release，Gitee 为唯一副本，保留\n' "$repo" "$rtag"
      excepted+=("$rtag")
      continue
    fi
    victims+=("${asc[$i]}")
  done

  if [ "${#victims[@]}" -eq 0 ]; then
    if [ "${#excepted[@]}" -gt 0 ]; then
      printf '   将删除: 无（%s 条待删版本命中显式例外清单，保留）\n' "${#excepted[@]}"
    else
      printf '   将删除: 无（可判序 release %s <= --keep %s）\n' "$ncand" "$KEEP"
    fi
    printf '   [%s] 无需清理\n' "$([ "$DRY_RUN" = 1 ] && echo DRY-RUN || echo OK)"
    rm -f "$tmp"; return 0
  fi

  local -a vtags=()
  for line in "${victims[@]}"; do
    IFS=$'\t' read -r ver rid rtag <<< "$line"
    vtags+=("$rtag")
  done
  printf '   将删除（版本序，旧→新，%s 个）: %s\n' "${#vtags[@]}" "${vtags[*]}"

  # ── 护栏①：删除后剩余数量必须等于 --keep + 本仓命中的显式例外数 ──
  local remaining=$(( total - ${#victims[@]} ))
  local expect_remaining=$(( KEEP + ${#excepted[@]} ))
  local exc_note=""
  [ "${#excepted[@]}" -eq 0 ] || exc_note=" + 显式例外 ${#excepted[@]}"
  if [ "$remaining" -ne "$expect_remaining" ]; then
    printf '   [FAIL] 护栏①不成立：删除 %s 条后剩余 %s != --keep %s%s\n' "${#victims[@]}" "$remaining" "$KEEP" "$exc_note"
    printf '          原因：有 %s 条 release 的 tag 不参与判序，无法保证收敛到 %s 条；中止该仓、不删\n' "$unparsed" "$KEEP"
    rm -f "$tmp"; return 1
  fi
  printf '   ✓ 护栏①：删除 %s 条后剩余 %s == --keep %s%s\n' "${#victims[@]}" "$remaining" "$KEEP" "$exc_note"

  # ── 护栏②：被删版本必须全部严格小于保留集最小版本 ──
  local min_kept bad=0
  min_kept="$(printf '%s\n' "${keep_vers[@]}" | sort -V | head -n 1)"
  for line in "${victims[@]}"; do
    IFS=$'\t' read -r ver rid rtag <<< "$line"
    if ! version_lt "$ver" "$min_kept"; then
      bad=1
      printf '   [FAIL] 护栏②不成立：待删 %s（版本 %s）不小于保留集最小版本 %s\n' "$rtag" "$ver" "$min_kept"
    fi
  done
  if [ "$bad" = 1 ]; then
    printf '   [FAIL] 被删版本未全部小于保留集最小版本；中止该仓、不删\n'
    rm -f "$tmp"; return 1
  fi
  printf '   ✓ 护栏②：被删版本全部 < 保留集最小版本 %s\n' "$min_kept"

  if [ "$DRY_RUN" = 1 ]; then
    printf '   [DRY-RUN] 以上仅为计划，未执行删除\n'
    rm -f "$tmp"; return 0
  fi

  local rc=0
  for line in "${victims[@]}"; do
    IFS=$'\t' read -r ver rid rtag <<< "$line"
    local afile; afile="$(mktemp)"
    local acode; acode="$(api_get "/repos/$repo/releases/$rid/attach_files" "$afile")"
    local an=0
    [ "$acode" = "200" ] && an="$(jq 'length' "$afile" 2>/dev/null || echo 0)"
    printf '   - 删除 %s（release id=%s，附件 %s 个）\n' "$rtag" "$rid" "$an"
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
  done

  rm -f "$tmp"
  local after; after="$(mktemp)"
  local n; n="$(list_releases "$repo" "$after")" || n="?"
  printf '   清理后 release 数: %s\n' "$n"
  [ "$n" = "$expect_remaining" ] || { printf '   [FAIL] 清理后数量不等于 %s（--keep %s%s）\n' "$expect_remaining" "$KEEP" "$exc_note"; rc=1; }
  [ "${#excepted[@]}" -eq 0 ] || printf '   例外保留: %s\n' "${excepted[*]}"
  rm -f "$after"
  return "$rc"
}

[ "${#REPOS[@]}" -gt 0 ] || REPOS=("$(infer_repo)")

FAILED=0
for r in "${REPOS[@]}"; do
  [[ "$r" == */* ]] || { printf '[FAIL] 仓库格式应为 owner/name: %s\n' "$r"; FAILED=1; continue; }
  prune_repo "$r" || FAILED=1
done

[ "$FAILED" = 0 ] || { printf '\n[FAIL] 存在失败项，见上方输出\n' >&2; exit 1; }
[ "$SKIPPED" -eq 0 ] || printf '\n[WARN] 因判序歧义跳过 %s 仓（未做任何删除）\n' "$SKIPPED"
printf '\n[DONE] 全部完成%s\n' "$([ "$DRY_RUN" = 1 ] && echo '（dry-run，未删除）' || echo '')"
