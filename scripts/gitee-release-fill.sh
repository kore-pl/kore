#!/usr/bin/env bash
# gitee-release-fill.sh — 补建 Gitee release 与发行资产（幂等）
#
# 背景：Gitea 是权威源，GitHub / Gitee 是镜像；release 只在 GitHub 侧生成，
# Gitee 侧需补建。若执行进程没有继承 GITEE_TOKEN，就会出现「tag 已推、
# release 页缺失」——这正是 release-batch8 的形态。
#
# 幂等行为：
#   1) 读本地 tag（仅 v<major> 开头；pkg/* 子模块 tag 跳过）
#   2) 读 Gitee 现有 release
#   3) tag 无 release → 建（必须带 target_commitish，Gitee 强制要求）
#   4) release 已有但缺 dist 资产 → 只补传资产
#   5) 上传后下载回读 sha256，与本地 dist 比对
#
# 用法:
#   scripts/gitee-release-fill.sh [--dry-run] [--keep N] [--latest N] [--require-dist]
#                                 [--dir PATH]... [--repo owner/name]... [--all]
#
#   --dry-run       只读：打印缺口与计划，不发写请求（无需 token）
#   --keep N        保留上限，默认 5；补建后超限只 WARN，并提示先跑 prune --dry-run
#   --latest N      只处理最新的 N 个 tag（按版本倒序），0=全部（默认 0）
#   --require-dist  本地无 dist 产物时跳过该 tag（不建空 release），计入「无法补建」
#   --dir PATH      本地仓库目录，可重复；默认当前目录
#   --repo o/r      远端仓库，可重复；缺省由 --dir 的 gitee remote 推断
#   --all           扫描上级目录下 kore / kore-plugins / kore-plugin-*
#
# 校验: 建完逐个 tag 走「公开未鉴权 GET /releases/tags/<tag>」+ 资产下载回读 sha256。
# 凭据: 环境变量 GITEE_TOKEN（必填，--dry-run 除外）。禁止把 token 写进本文件、
#       提交历史或日志（G-30）。
# 退出码: 0 全部达成；1 任一仓库失败或 sha 校验不一致。
set -uo pipefail

API_BASE="${GITEE_API_BASE:-https://gitee.com/api/v5}"
KEEP=5
LATEST=0
REQUIRE_DIST=0
DRY_RUN=0
SCAN_ALL=0
DIRS=()
REPOS=()

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
die()  { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
info() { printf '   %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --keep)    [ $# -ge 2 ] || die "--keep 需要参数"; KEEP="$2"; shift 2 ;;
    --latest)  [ $# -ge 2 ] || die "--latest 需要参数"; LATEST="$2"; shift 2 ;;
    --require-dist) REQUIRE_DIST=1; shift ;;
    --dir)     [ $# -ge 2 ] || die "--dir 需要参数"; DIRS+=("$2"); shift 2 ;;
    --repo)    [ $# -ge 2 ] || die "--repo 需要参数"; REPOS+=("$2"); shift 2 ;;
    --all)     SCAN_ALL=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "未知参数: $1（--help 查看用法）" ;;
  esac
done

case "$KEEP" in ''|*[!0-9]*) die "--keep 必须是正整数（当前 '$KEEP'）" ;; esac
[ "$KEEP" -ge 1 ] || die "--keep 必须 >= 1"
case "$LATEST" in ''|*[!0-9]*) die "--latest 必须是非负整数（当前 '$LATEST'）" ;; esac

if [ "$DRY_RUN" = 0 ]; then
  [ -n "${GITEE_TOKEN:-}" ] || die "GITEE_TOKEN 未设置（export GITEE_TOKEN=... 后再跑；只读审计可用 --dry-run）"
fi

# 只有既有 token 才带鉴权头；dry-run 无 token 也能走公开只读 API
api() {  # $1=method $2=path $3=outfile ; 打印 http 码
  local method="$1" path="$2" out="$3" code
  local url="$API_BASE$path"
  if [ -n "${GITEE_TOKEN:-}" ]; then
    code="$(curl -sS --max-time 120 -X "$method" \
      -H "Authorization: token ${GITEE_TOKEN}" "$url" -o "$out" -w '%{http_code}')"
  else
    code="$(curl -sS --max-time 120 -X "$method" "$url" -o "$out" -w '%{http_code}')"
  fi
  printf '%s' "$code"
}

parse_repo() {  # gitee remote URL -> owner/name
  local u="${1%.git}"
  case "$u" in
    *gitee.com/*) printf '%s' "${u##*gitee.com/}" ;;
    *gitee.com:*) printf '%s' "${u##*gitee.com:}" ;;
    *) printf '' ;;
  esac
}

infer_repo_dir() {  # $1=owner/name -> 本地目录
  local name="${1##*/}"
  [ -d "$name/.git" ] && { printf '%s' "$name"; return; }
  [ -d "../$name/.git" ] && { printf '%s' "../$name"; return; }
  printf ''
}

list_releases() {  # $1=repo $2=outfile ; 打印数量
  local repo="$1" out="$2" page=1 total=0
  : > "$out"
  while :; do
    local tmp code n
    tmp="$(mktemp)"
    code="$(api GET "/repos/$repo/releases?page=$page&per_page=100" "$tmp")"
    if [ "$code" != "200" ]; then rm -f "$tmp"; return 1; fi
    n="$(python3 -c 'import json,sys
try: print(len(json.load(open(sys.argv[1]))))
except Exception: print(0)' "$tmp")"
    # 摊平成 JSONL：一行一个 release 对象，供后续按 tag 精确取用
    python3 -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d=[]
if not isinstance(d,list): d=[]
for x in d: print(json.dumps(x,ensure_ascii=False))' "$tmp" >> "$out"
    rm -f "$tmp"
    total=$((total + n))
    [ "$n" -lt 100 ] && break
    page=$((page + 1))
  done
  printf '%s' "$total"
}

changelog_body() {  # $1=dir $2=version ; 输出该版本 CHANGELOG 段落（可能为空）
  local dir="$1" v="$2"
  [ -f "$dir/CHANGELOG.md" ] || return 0
  awk -v v="$v" '
    index($0,"## "v)==1 || index($0,"## ["v"]")==1 { f=1; next }
    f && /^## / { exit }
    f { print }
  ' "$dir/CHANGELOG.md"
}

dist_asset() {  # $1=dir $2=tag ; 输出本地 dist 资产路径（可能为空）
  local dir="$1" tag="$2" ver="${2#v}" id
  id="$(basename "$dir")"; id="${id#kore-plugin-}"
  [ -f "$dir/dist/$id-$ver.tar.gz" ] && { printf '%s' "$dir/dist/$id-$ver.tar.gz"; return; }
  printf ''
}

release_id_of_tag() {  # $1=releases.jsonl $2=tag
  python3 -c 'import json,sys
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("tag_name")==sys.argv[2]: print(d.get("id") or ""); break' "$1" "$2"
}

has_asset() {  # $1=releases.jsonl $2=tag $3=asset名 → yes/no
  python3 -c 'import json,sys
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("tag_name")==sys.argv[2]:
        print("yes" if any((a.get("name")==sys.argv[3]) for a in (d.get("assets") or [])) else "no")
        raise SystemExit
print("no")' "$1" "$2" "$3"
}

fill_repo() {
  local dir="$1" repo="$2"
  local tmp; tmp="$(mktemp)"
  local rc=0

  printf '\n== %s（%s）==\n' "$repo" "$dir"

  local total
  total="$(list_releases "$repo" "$tmp")" || { printf '[FAIL] %s: 拉取 release 列表失败\n' "$repo"; rm -f "$tmp"; return 1; }
  info "现有 release: $total"

  # 本地 tag：仅 v<major>，跳过 pkg/pluginapi/* 这类子模块 tag
  local tags tag
  tags="$(git -C "$dir" tag --sort=-v:refname | grep -E '^v[0-9]' || true)"
  if [ "$LATEST" -gt 0 ] && [ -n "$tags" ]; then
    tags="$(printf '%s\n' "$tags" | head -n "$LATEST")"
  fi
  [ -n "$tags" ] || { info "无 v* tag，跳过"; rm -f "$tmp"; return 0; }

  local created=0 uploaded=0 skipped=0 planned=0 nodist=0
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    local rid asset
    rid="$(release_id_of_tag "$tmp" "$tag")"
    asset="$(dist_asset "$dir" "$tag")"

    if [ -n "$rid" ]; then
      if [ -n "$asset" ] && [ "$(has_asset "$tmp" "$tag" "$(basename "$asset")")" = no ]; then
        if [ "$DRY_RUN" = 1 ]; then
          info "[DRY] $tag：release 已存在（id=$rid），缺资产 $(basename "$asset") → 计划补传"
        else
          local code; code="$(curl -sS --max-time 300 -X POST \
            -H "Authorization: token ${GITEE_TOKEN}" -F "file=@$asset" \
            "$API_BASE/repos/$repo/releases/$rid/attach_files" \
            -o "$(mktemp)" -w '%{http_code}')"
          printf '   %s：补传资产 %s → HTTP %s\n' "$tag" "$(basename "$asset")" "$code"
          case "$code" in 200|201) uploaded=$((uploaded + 1)) ;; *) warn "$tag 资产补传失败"; rc=1 ;; esac
        fi
      else
        skipped=$((skipped + 1))
      fi
      continue
    fi

    # 无 release：建
    if [ "$REQUIRE_DIST" = 1 ] && [ -z "$asset" ]; then
      info "[SKIP] $tag：本地无 dist 资产 → 无法补建（不建空 release）"
      nodist=$((nodist + 1)); continue
    fi
    local sha bodyfile
    sha="$(git -C "$dir" rev-parse "$tag^{commit}" 2>/dev/null || true)"
    [ -n "$sha" ] || { warn "$tag 无法解析 commit，跳过"; rc=1; continue; }
    bodyfile="$(mktemp)"
    changelog_body "$dir" "${tag#v}" > "$bodyfile"

    if [ "$DRY_RUN" = 1 ]; then
      planned=$((planned + 1))
      info "[DRY] $tag：缺 release（@ $sha）→ 计划创建$([ -n "$asset" ] && printf '并挂 %s' "$(basename "$asset")" || printf '（无 dist 资产）')"
      rm -f "$bodyfile"
      continue
    fi

    local code rid_new
    code="$(curl -sS --max-time 120 -X POST \
      -H "Authorization: token ${GITEE_TOKEN}" \
      --data-urlencode "tag_name=$tag" \
      --data-urlencode "name=$tag" \
      --data-urlencode "body@$bodyfile" \
      --data-urlencode "target_commitish=$sha" \
      --data-urlencode "prerelease=false" \
      "$API_BASE/repos/$repo/releases" -o "$bodyfile.resp" -w '%{http_code}')"
    rid_new="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("id") or "")
except Exception: print("")' "$bodyfile.resp")"
    if [ "$code" != "201" ] || [ -z "$rid_new" ]; then
      printf '   [FAIL] %s：创建失败 HTTP %s %s\n' "$tag" "$code" "$(head -c 200 "$bodyfile.resp")"
      rm -f "$bodyfile" "$bodyfile.resp"; rc=1; continue
    fi
    created=$((created + 1))
    printf '   %s：创建 release HTTP %s id=%s\n' "$tag" "$code" "$rid_new"

    if [ -n "$asset" ]; then
      local ucode
      ucode="$(curl -sS --max-time 300 -X POST \
        -H "Authorization: token ${GITEE_TOKEN}" -F "file=@$asset" \
        "$API_BASE/repos/$repo/releases/$rid_new/attach_files" \
        -o "$bodyfile.up" -w '%{http_code}')"
      printf '   %s：上传 %s → HTTP %s\n' "$tag" "$(basename "$asset")" "$ucode"
      case "$ucode" in 200|201) uploaded=$((uploaded + 1)) ;; *) warn "$tag 资产上传失败"; rc=1 ;; esac
    else
      warn "$tag 无本地 dist 资产（dist/<id>-<ver>.tar.gz），release 不含发行包"
    fi
    rm -f "$bodyfile" "$bodyfile.resp" "$bodyfile.up"
  done <<< "$tags"

  if [ "$DRY_RUN" = 1 ]; then
    info "[DRY] 计划：新建 $planned 个 release；补建后 release 数 $((total + planned))（现有 $total，保留上限 $KEEP）$([ "$nodist" -gt 0 ] && printf '；无法补建 %s 个' "$nodist")"
    rm -f "$tmp"
    return 0
  fi

  # 回读校验：数量 + 资产 sha256（仅非 dry-run）
  if [ "$DRY_RUN" = 0 ]; then
    local after; after="$(mktemp)"
    local after_n; after_n="$(list_releases "$repo" "$after")" || after_n="?"
    info "补建后 release 数: $after_n（本次新建 $created，补传 $uploaded，已完整 $skipped）"
    if [ "$after_n" != "?" ] && [ "$after_n" -gt "$KEEP" ]; then
      warn "$repo 超过保留策略 $KEEP 个，先跑 scripts/gitee-release-prune.sh --dry-run 再决定"
    fi
    # 逐 tag 校验 dist 资产的 sha256
    while IFS= read -r tag; do
      [ -n "$tag" ] || continue
      local a; a="$(dist_asset "$dir" "$tag")"
      [ -n "$a" ] || continue
      local rid2; rid2="$(release_id_of_tag "$after" "$tag")"
      [ -n "$rid2" ] || continue
      local url; url="$(python3 -c 'import json,sys
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get("tag_name")==sys.argv[2]:
        for x in (d.get("assets") or []):
            if x.get("name")==sys.argv[3]: print(x.get("browser_download_url") or ""); break
        break' "$after" "$tag" "$(basename "$a")")"
      [ -n "$url" ] || { warn "$tag 回读不到资产 URL"; rc=1; continue; }
      local dl; dl="$(mktemp)"
      local dcode; dcode="$(curl -sSL --max-time 300 "$url" -o "$dl" -w '%{http_code}')"
      local want got
      want="$(sha256sum "$a" | cut -d' ' -f1)"
      got="$(sha256sum "$dl" | cut -d' ' -f1)"
      if [ "$dcode" = "200" ] && [ "$want" = "$got" ]; then
        printf '   [OK] %s 资产校验 http=%s sha256=%s\n' "$tag" "$dcode" "$got"
      else
        printf '   [FAIL] %s 资产校验 http=%s want=%s got=%s\n' "$tag" "$dcode" "$want" "$got"
        rc=1
      fi
      rm -f "$dl"
    done <<< "$tags"
    # 公开视角校验：未鉴权 GET /releases/tags/<tag> 必须 200（证明镜像对外可见）
    # 并发跑多仓时可置 SKIP_PUBLIC_CHECK=1 跳过（匿名 API 有 IP 级限流），事后单独串行复核
    while [ "${SKIP_PUBLIC_CHECK:-0}" != "1" ] && IFS= read -r tag; do
      [ -n "$tag" ] || continue
      local pcode pub try
      pub="$(mktemp)"
      pcode=""
      for try in 1 2 3 4; do   # 匿名 API 有 IP 级限流，403/429 退避重试
        pcode="$(curl -sS --max-time 60 "$API_BASE/repos/$repo/releases/tags/$tag" -o "$pub" -w '%{http_code}')"
        [ "$pcode" = "200" ] && break
        sleep $((try * 2))
      done
      sleep 1
      if [ "$pcode" = "200" ]; then
        printf '   [OK] %s 公开视角 GET /releases/tags/%s → 200\n' "$tag" "$tag"
      else
        printf '   [FAIL] %s 公开视角 GET /releases/tags/%s → HTTP %s\n' "$tag" "$tag" "$pcode"
        rc=1
      fi
      rm -f "$pub"
    done <<< "$tags"
    rm -f "$after"
  fi

  rm -f "$tmp"
  return "$rc"
}

# ---- 目标解析 ----
if [ "${#DIRS[@]}" -eq 0 ] && [ "${#REPOS[@]}" -eq 0 ] && [ "$SCAN_ALL" = 0 ]; then
  DIRS=(".")
fi
if [ "$SCAN_ALL" = 1 ]; then
  for d in ../kore ../kore-plugins ../kore-plugin-*; do
    [ -d "$d/.git" ] && DIRS+=("$d")
  done
fi

TARGETS=()
for d in "${DIRS[@]:-}"; do
  [ -n "$d" ] || continue
  [ -d "$d/.git" ] || die "不是 git 仓库: $d"
  r="$(parse_repo "$(git -C "$d" remote get-url gitee 2>/dev/null || true)")"
  [ -n "$r" ] || die "$d 没有 gitee remote，无法推断 owner/repo（也可用 --repo 显式指定）"
  TARGETS+=("$d|$r")
done
for r in "${REPOS[@]:-}"; do
  [ -n "$r" ] || continue
  [[ "$r" == */* ]] || die "仓库格式应为 owner/name: $r"
  d="$(infer_repo_dir "$r")"
  [ -n "$d" ] || die "$r 找不到对应本地目录（dist 资产在本地），请用 --dir 指定"
  TARGETS+=("$d|$r")
done
[ "${#TARGETS[@]}" -gt 0 ] || die "没有可处理的目标"

FAILED=0
for t in "${TARGETS[@]}"; do
  fill_repo "${t%%|*}" "${t##*|}" || FAILED=1
done

if [ "$FAILED" = 0 ]; then
  printf '\n[DONE] 全部达成%s\n' "$([ "$DRY_RUN" = 1 ] && echo '（dry-run，未写任何数据）' || echo '')"
else
  printf '\n[FAIL] 存在失败项，见上方输出\n' >&2; exit 1
fi
