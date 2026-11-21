#!/usr/bin/env bash
# dep-check — 主壳依赖白名单（只约束第三方；同仓嵌套 module 不计入配额）
# 判定：
#   1) 第三方直接依赖 ∈ { yaml.v3, bbolt, protobuf }，且数量 ≤ 3
#   2) 以 github.com/kore-project/kore/ 开头的同仓 module：允许，不计配额，
#      但必须在 go.mod 用 replace => ./ 指向仓库内路径（../ 与绝对路径一律禁止）
#   3) replace 解析同时支持单行与 replace ( ... ) 块两种 Go 合法写法
# 用法: bash scripts/dep-check.sh [含 go.mod 的目录]   （默认当前目录）
# 退出码：存在 FAIL → 1；通过或无 go.mod → 0
set -euo pipefail

DIR="${1:-.}"
MOD="${DIR%/}/go.mod"

SELF_PREFIX='github.com/kore-project/kore/'
THIRD_WHITELIST='gopkg.in/yaml.v3 go.etcd.io/bbolt google.golang.org/protobuf'
MAX_THIRD=3

PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '[OK] %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$*"; }

if [ ! -f "$MOD" ]; then
  printf '[N/A] 源码未就绪（无 %s），依赖白名单检查跳过，M1 自动生效\n' "$MOD"
  exit 0
fi

# ---- require：单行 + 块形式；排除注释与 // indirect ----
requires=$(
  awk '
    /^require[[:space:]]*\(/ { inb = 1; next }
    inb && /^\)/ { inb = 0; next }
    inb && NF >= 2 && $0 !~ /^[[:space:]]*\/\// && $0 !~ /indirect/ { print $1; next }
    /^require[[:space:]]+[^(]/ && NF >= 3 && $0 !~ /indirect/ { print $2 }
  ' "$MOD" | sed '/^$/d' | sort -u
)

# ---- replace：单行 + 块形式，输出 "module<TAB>target" ----
replaces=$(
  awk '
    function emit(line,   parts, lhs, rhs, lf, rf, mod, target) {
      if (split(line, parts, "=>") < 2) return
      lhs = parts[1]
      rhs = parts[2]
      sub(/^[[:space:]]*replace[[:space:]]+/, "", lhs)
      sub(/^[[:space:]]+/, "", lhs)   # 块形式行首是 tab，必须先 trim 再 split，否则 lf[1] 为空
      sub(/^[[:space:]]+/, "", rhs)
      split(lhs, lf, /[[:space:]]+/)
      split(rhs, rf, /[[:space:]]+/)
      mod = lf[1]
      target = rf[1]
      if (mod != "" && target != "") printf "%s\t%s\n", mod, target
    }
    /^replace[[:space:]]*\(/ { inb = 1; next }
    inb && /^\)/ { inb = 0; next }
    inb && $0 !~ /^[[:space:]]*\/\// && $0 ~ /=>/ { emit($0); next }
    /^replace[[:space:]]+/ && $0 ~ /=>/ { emit($0) }
  ' "$MOD"
)

# ---- 规则 A：replace 不得指向仓库外（../ 或绝对路径）----
while IFS=$'\t' read -r mod target; do
  if [ -z "${mod:-}" ]; then
    continue
  fi
  case "$target" in
    ./*) : ;;  # 仓库内相对路径：允许
    ../*|/*)
      bad "replace 指向仓库外: ${mod} => ${target}（只允许 ./ 相对路径；跨仓联调走 go.work）"
      ;;
    *) : ;;    # 模块替换（=> 另一 module 版本），不是本地路径，交由依赖清单判定
  esac
done <<< "$replaces"

# ---- 规则 B：依赖分类 ----
THIRD=()
SAME=()
while IFS= read -r d; do
  if [ -z "$d" ]; then
    continue
  fi
  case "$d" in
    "${SELF_PREFIX}"*) SAME+=("$d") ;;
    *) THIRD+=("$d") ;;
  esac
done <<< "$requires"

# ---- 规则 C：同仓 module 必须 replace => ./ ----
for d in "${SAME[@]+"${SAME[@]}"}"; do
  tgt=$(printf '%s\n' "$replaces" | awk -F'\t' -v m="$d" '$1 == m { print $2; exit }')
  if [ -z "$tgt" ]; then
    bad "同仓 module 缺 replace: ${d}（应 ${d} => ./pkg/...）"
  else
    case "$tgt" in
      ./*) ok "同仓 module: ${d}（replace => ${tgt}，不计入第三方配额）" ;;
      *) : ;;  # 仓库外路径已在规则 A 报错，不重复计
    esac
  fi
done

# ---- 规则 D：第三方白名单 + 数量上限 ----
TN=0
NON_WHITELIST=0
for d in "${THIRD[@]+"${THIRD[@]}"}"; do
  TN=$((TN + 1))
  case " ${THIRD_WHITELIST} " in
    *" ${d} "*) : ;;
    *)
      bad "非白名单依赖: ${d}"
      NON_WHITELIST=$((NON_WHITELIST + 1))
      ;;
  esac
done

if [ "$TN" -gt "$MAX_THIRD" ]; then
  bad "第三方依赖 ${TN}/${MAX_THIRD} 超过上限 ${MAX_THIRD}"
elif [ "$NON_WHITELIST" -eq 0 ]; then
  ok "第三方依赖 ${TN}/${MAX_THIRD}（${THIRD[*]:-无}）"
fi

printf '\n'
printf 'dep-check: %d pass, %d fail\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
