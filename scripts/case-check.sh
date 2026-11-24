#!/usr/bin/env bash
# case-check — 大小写一致性门禁（make check 第 9 段）
#
# 为什么要有这一段：Go module 路径、GitHub 仓库名、Windows/macOS 文件系统三处规则不同。
#   - Go module 路径出现大写 → Go 会转义成 `!`，依赖方 require 写不对直接拉不到；
#   - GitHub 仓库名大小写不敏感但 URL 会误导别人 clone；
#   - Windows / macOS 文件系统大小写不敏感 → 同一目录下 `Foo.go` 与 `foo.go` 会静默互相覆盖，
#     Linux 上开发一切正常，别人一 clone 就少文件 / 编译炸。
#
# 判定五项（1/2/4 阻断，3/5 告警）：
#   1/5 module 路径：`go list -m` 必须全小写且不含 Go 的大小写转义 `!`            → FAIL
#   2/5 同目录大小写冲突：同一目录内不得存在仅大小写不同的文件 / 目录              → FAIL
#   3/5 旧仓库名残留：大写 K + 大写 P 的连字符写法零命中（豁免 docs/DECISIONS/、.agents/LOG/）  → WARN
#   4/5 插件 id：`../kore-plugin-*/info.json` 的 id 必须匹配 ^[a-z][a-z0-9-]*$     → FAIL
#   5/5 文档 URL：所有 *.md 里 github.com/<owner> 的 owner 段必须全小写           → WARN
#
# 用法: bash scripts/case-check.sh
# 退出码: 存在 FAIL → 1；只有 WARN → 0（告警不阻断日常提交）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
WARN=0
FAIL=0

pass()    { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
warn()    { WARN=$((WARN + 1)); printf '[WARN] %s\n' "$*"; }
failed()  { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$*"; }
detail()  { printf '       %s\n' "$*"; }
section() { printf '\n-- %s --\n' "$*"; }
lower()   { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------------------------------------------------------------- 1/5 module 路径
section "1/5 module 路径（go list -m 全小写，无 '!' 转义）"
MOD_BAD=0
if ! command -v go >/dev/null 2>&1; then
  failed "go 命令不可用，无法校验 module 路径"
else
  MOD_PATH="$(go list -m 2>/dev/null | head -n 1 || true)"
  if [ -z "$MOD_PATH" ]; then
    failed "go list -m 无输出（当前目录不是 Go module 根？）"
    MOD_BAD=1
  else
    case "$MOD_PATH" in
      *'!'*)
        failed "module 路径含 Go 大小写转义 '!'（源码里写了大写字母）: $MOD_PATH"
        MOD_BAD=1
        ;;
    esac
    if printf '%s' "$MOD_PATH" | grep -q '[A-Z]'; then
      failed "module 路径含大写字母: $MOD_PATH"
      MOD_BAD=1
    fi
  fi
  # 依赖侧同理：依赖里混入大写模块路径，别人 go mod download 一样会踩坑。
  if ALL_MODS="$(go list -m all 2>/dev/null)"; then
    BAD_DEPS="$(printf '%s\n' "$ALL_MODS" | awk '{print $1}' | grep '!' || true)"
    if [ -n "$BAD_DEPS" ]; then
      failed "依赖模块路径含 '!' 转义: $(printf '%s' "$BAD_DEPS" | tr '\n' ' ')"
      MOD_BAD=1
    fi
  fi
  if [ "$MOD_BAD" -eq 0 ]; then
    pass "module 路径全小写、无 '!' 转义: $MOD_PATH"
  fi
fi

# ---------------------------------------------------------------- 2/5 同目录大小写冲突
section "2/5 同一目录内大小写冲突（文件 + 目录；Windows/macOS 会静默覆盖）"
COLLISIONS="$(
  find . -path ./.git -prune -o \( -type f -o -type d \) -print0 2>/dev/null |
    while IFS= read -r -d '' p; do
      [ "$p" = "." ] && continue
      printf '%s/%s\t%s\n' "$(lower "$(dirname "$p")")" "$(lower "$(basename "$p")")" "$p"
    done |
    sort |
    awk -F'\t' '
      {
        key = $1
        if (key != prev) {
          if (cnt > 1) printf "%s ->%s\n", prev, buf
          prev = key; buf = " " $2; cnt = 1
        } else {
          buf = buf " " $2; cnt++
        }
      }
      END { if (cnt > 1) printf "%s ->%s\n", prev, buf }
    ' |
    sort
)"
if [ -z "$COLLISIONS" ]; then
  pass "无同目录大小写冲突（文件与目录均已扫描，已排除 .git）"
else
  COLLIDE_N="$(printf '%s\n' "$COLLISIONS" | grep -c . || true)"
  failed "发现 ${COLLIDE_N} 组同目录大小写冲突（大小写不敏感文件系统上会互相覆盖）"
  printf '%s\n' "$COLLISIONS" | head -10 | while IFS= read -r line; do
    detail "冲突组: $line"
  done
fi

# ---------------------------------------------------------------- 3/5 旧仓库名残留
section "3/5 旧仓库名残留（大写 K + 大写 P 的连字符写法）"
# 模式拼接构造，避免脚本自身文本被 grep 命中（否则本门禁永远有一条 WARN）。
OLD_NAME='Kore'-'Project'
# 豁免：ADR 必须能点名「被否决的选项」，台账必须能记录「当时探测到的组织」——记录类文件不参与本规则。
EXEMPT_RE='^\./(docs/DECISIONS|\.agents/LOG)/'
RAW_HITS="$(grep -rnI -F "$OLD_NAME" . --exclude-dir=.git 2>/dev/null || true)"
EXEMPT_HITS="$(printf '%s\n' "$RAW_HITS" | grep -E -- "$EXEMPT_RE" || true)"
HITS="$(printf '%s\n' "$RAW_HITS" | grep -vE -- "$EXEMPT_RE" || true)"
EXEMPT_N="$(printf '%s\n' "$EXEMPT_HITS" | grep -c . || true)"
if [ -z "$HITS" ]; then
  pass "旧仓库名残留（已豁免 docs/DECISIONS/ 与 .agents/LOG/ 的历史指称：${EXEMPT_N} 行属被否决选项/探测记录）"
else
  HITS_N="$(printf '%s\n' "$HITS" | grep -c . || true)"
  warn "发现 ${HITS_N} 处旧写法（WARN 级，已豁免记录类文件 ${EXEMPT_N} 行）：真引用改 pengtang1024/kore，假设名统一写 kore-project"
  printf '%s\n' "$HITS" | head -10 | while IFS= read -r l; do
    detail "$l"
  done
fi

# ---------------------------------------------------------------- 4/5 插件 id
section "4/5 插件 id（../kore-plugin-*/info.json 匹配 ^[a-z][a-z0-9-]*$）"
MANIFESTS="$(ls -1 ../kore-plugin-*/info.json 2>/dev/null || true)"
if [ -z "$MANIFESTS" ]; then
  pass "未发现 ../kore-plugin-*/info.json（本轮无同类插件仓库可查，跳过）"
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    id="$(sed -n 's/^[[:space:]]*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -n 1)"
    if [ -z "$id" ]; then
      failed "info.json 缺 id 字段: $f"
    elif [[ "$id" =~ ^[a-z][a-z0-9-]*$ ]]; then
      pass "插件 id 合法: '$id'（$f）"
    else
      failed "插件 id 不合法（应 ^[a-z][a-z0-9-]*$）: '$id'（$f）"
    fi
  done <<< "$MANIFESTS"
fi

# ---------------------------------------------------------------- 5/5 文档 GitHub URL owner
section "5/5 文档 GitHub URL owner 段（*.md 内 github.com/<owner> 全小写）"
# 扫描范围 = 本仓受版本控制的 *.md（git ls-files），不是 `find .`。理由（2026-11-24 实测）：
# `find .` 会扫进 gitignored 的第三方产物——`web/node_modules/tslib/README.md` 里有 4 条
# `github.com/Microsoft/TypeScript/...`，那是上游包的 README，不随本仓发布、改它下次 npm
# install 就还原，且干净 clone 上根本不存在 → 用 find 会让门禁结果依赖「本机装没装前端依赖」，
# 同一个 commit 在 CI 与开发机可能一绿一黄（非确定性门禁）。判据本身不放宽：本仓自己写的
# 每一份受控 *.md 仍逐条校验，URL owner 大小写不符合照样 WARN。
# 排除项与 docs-check 口径一致：冻结证据 `.agents/verify/`（按证据规范，不改写历史原文；
# 其中引用了本期 WARN 原文）、历史指称 `docs/DECISIONS/` 与 `.agents/LOG/`（ADR / 台账里
# 记录的是彼时的组织名，改写历史即失真）。
URLS="$(
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git ls-files -z -- '*.md' 2>/dev/null |
      grep -zvE '^(docs/DECISIONS/|\.agents/LOG/|\.agents/verify/)' |
      xargs -0 -r grep -hoI 'github\.com/[A-Za-z0-9._/-]*' 2>/dev/null
  else
    # 非 git 环境（打包源码 / git archive 解压目录）退回文件系统扫描，但同样排除第三方产物与冻结证据。
    find . -type f -name '*.md' -not -path './.git/*' -not -path '*/node_modules/*' \
      -not -path './docs/DECISIONS/*' -not -path './.agents/LOG/*' -not -path './.agents/verify/*' \
      -print0 2>/dev/null | xargs -0 -r grep -hoI 'github\.com/[A-Za-z0-9._/-]*' 2>/dev/null
  fi | sort -u || true
)"
if [ -z "$URLS" ]; then
  warn "未发现任何 github.com URL（文档可能缺仓库链接，需人工判；WARN 级不阻断）"
else
  URL_N="$(printf '%s\n' "$URLS" | grep -c . || true)"
  BAD_URLS=""
  while IFS= read -r u; do
    [ -z "$u" ] && continue
    rest="${u#github.com/}"
    owner="${rest%%/*}"
    if [ "$owner" != "$(lower "$owner")" ]; then
      BAD_URLS="${BAD_URLS}${u}"$'\n'
    fi
  done <<< "$URLS"
  if [ -z "$BAD_URLS" ]; then
    pass "全部 ${URL_N} 个 github.com URL 的 owner 段全小写（范围=受控 *.md；已排除 node_modules 第三方产物、冻结证据 .agents/verify/、历史指称 docs/DECISIONS/ 与 .agents/LOG/）"
  else
    BAD_N="$(printf '%s' "$BAD_URLS" | grep -c . || true)"
    warn "发现 ${BAD_N} 个 URL 的 owner 段含大写（WARN 级；clone 命令会误导对方）"
    printf '%s' "$BAD_URLS" | head -10 | while IFS= read -r l; do
      detail "$l"
    done
  fi
fi

# ---------------------------------------------------------------- 汇总
printf '\n'
printf 'case-check: %d pass, %d warn, %d fail\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '结果: 门禁未通过（%d FAIL；1/2/4 为阻断级：module 路径、同目录大小写冲突、插件 id）\n' "$FAIL"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  printf '结果: 门禁通过（%d WARN 不阻断；3/5 为告警级：旧仓库名、文档 URL owner 大小写）\n' "$WARN"
else
  printf '结果: 门禁通过（5 项全绿）\n'
fi
exit 0
