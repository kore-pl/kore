#!/usr/bin/env bash
# canonical-check — 口径唯一性门禁（现役数字只能有一个版本）
# 规则1 ：48 MiB 只允许与「红线」同行（ADR-0016 起 48 MiB = 常驻合计硬红线）
# 规则1b：目标语境的 MiB 值不得 >24（48 出现在目标语境即旧口径残留）
# 规则1c：合计语境的红线不得写成 24 MiB（24 是目标，不是红线）—— WARN
# 规则2 ：GOGC=200 零命中（默认档由 ADR 定，双档对照不写字面量）
# 规则3 ：旧字段 type: resident|oneshot 零命中（字段名已改 lifecycle）
# 规则4 ：幽灵插件 id edge(/gateway(/sec( 零命中
# 规则5 ：AGENTS.md / RESOURCE-MODEL.md / V1-GOALS.md 三份各自都要含 24 MiB / 12 MiB / 推荐 ≤2
# 范围：AGENTS.md / README.md / docs/*.md（顶层，不含 docs/DECISIONS/——ADR 允许记录旧值与备选）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
WARN=0
FAIL=0

ok()     { PASS=$((PASS + 1)); printf '[OK] %s\n' "$*"; }
warn()   { WARN=$((WARN + 1)); printf '[WARN] %s\n' "$*"; }
bad()    { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$*"; }
detail() { printf '       %s\n' "$*"; }

FILES=(AGENTS.md README.md)
while IFS= read -r f; do
  if [ -n "$f" ]; then
    FILES+=("$f")
  fi
done < <(find docs -maxdepth 1 -type f -name '*.md' 2>/dev/null | sort)

MISSING=()
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    MISSING+=("$f")
  fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  bad "口径文件缺失 ${#MISSING[@]} 份"
  for m in "${MISSING[@]}"; do
    detail "缺失: $m"
  done
fi

# ---------------- 规则1：48 MiB 必须与「红线」同行 ----------------
HITS=$(grep -nH '48 MiB' "${FILES[@]}" 2>/dev/null || true)
if [ -z "$HITS" ]; then
  ok "规则1 48 MiB 仅允许与「红线」同行（无命中，天然合规）"
else
  TOTAL=0
  BADLINES=()
  while IFS= read -r l; do
    if [ -z "$l" ]; then
      continue
    fi
    TOTAL=$((TOTAL + 1))
    case "$l" in
      *红线*) : ;;
      *) BADLINES+=("$l") ;;
    esac
  done <<< "$HITS"
  if [ "${#BADLINES[@]}" -eq 0 ]; then
    ok "规则1 48 MiB 命中 ${TOTAL} 行，全部与「红线」同行"
  else
    bad "规则1 48 MiB 有 ${#BADLINES[@]} 行未与「红线」同行（会被误读成目标）"
    for l in "${BADLINES[@]}"; do
      detail "$l"
    done
  fi
fi

# ---------------- 规则1b：目标语境的 MiB 值不得 >24 ----------------
CANON=(AGENTS.md docs/RESOURCE-MODEL.md docs/V1-GOALS.md docs/VISION.md)
B1B=$(awk '
  function lastpos(str, pat,   i, p, r) {
    r = 0; i = 1
    while ((p = index(substr(str, i), pat)) > 0) { r = i + p - 1; i = r + length(pat) }
    return r
  }
  {
    line = $0
    start = 1
    while ((p = index(substr(line, start), "48 MiB")) > 0) {
      pos = start + p - 1
      pre = substr(line, 1, pos - 1)
      tj = lastpos(pre, "目标")
      tr = lastpos(pre, "红线")
      if (tj > 0 && tj > tr) printf "%s:%d\t48 MiB 落在目标语境（最近的「目标」之后没有「红线」）\n", FILENAME, FNR
      start = pos + 6
    }
  }
' "${CANON[@]}" 2>/dev/null || true)
if [ -z "$B1B" ]; then
  ok "规则1b 目标语境未出现 48 MiB（8/12/24/15/19.2 等目标值合法）"
else
  bad "规则1b 目标语境出现 48 MiB（把硬红线误写成目标）"
  printf '%s\n' "$B1B" | while IFS= read -r l; do
    detail "$l"
  done
fi

# ---------------- 规则1c：合计语境的红线不得写成 24 MiB（WARN） ----------------
C1C=$(grep -nHE '合计[^|。；]{0,20}红线[[:space:]]*≤?[[:space:]]*24 MiB' "${FILES[@]}" 2>/dev/null || true)
if [ -z "$C1C" ]; then
  ok "规则1c 合计语境未把 24 MiB 写成红线"
else
  warn "规则1c 合计语境出现「红线 24 MiB」——24 是目标不是红线（WARN，不阻断）"
  printf '%s\n' "$C1C" | head -5 | while IFS= read -r l; do
    detail "$l"
  done
fi

# ---------------- 规则2：GOGC=200 零命中 ----------------
forbid() {
  local desc="$1"
  local pattern="$2"
  local hits n
  hits=$(grep -nHE -- "$pattern" "${FILES[@]}" 2>/dev/null || true)
  if [ -z "$hits" ]; then
    ok "$desc 零命中"
  else
    n=$(printf '%s\n' "$hits" | wc -l)
    bad "$desc 命中 $n 处（现役口径唯一，旧值/幽灵 id 必须清零）"
    printf '%s\n' "$hits" | head -10 | while IFS= read -r l; do
      detail "$l"
    done
  fi
}

forbid "规则2 默认 GOGC=200"                   'GOGC=200'
forbid "规则3 旧字段 type: resident|oneshot"   'type:[[:space:]]*(resident|oneshot)'
forbid "规则4 幽灵插件 id edge(/gateway(/sec(" '(^|[^[:alnum:]_])(edge|gateway|sec)\('

# ---------------- 规则5：预算声明逐份必含 ----------------
CANON5=(AGENTS.md docs/RESOURCE-MODEL.md docs/V1-GOALS.md)
for f in "${CANON5[@]}"; do
  if [ ! -f "$f" ]; then
    bad "规则5 口径文件缺失: $f"
  fi
done
for tok in '24 MiB' '12 MiB' '推荐 ≤2'; do
  HITF=()
  MISSF=()
  for f in "${CANON5[@]}"; do
    if [ -f "$f" ] && grep -qF -- "$tok" "$f"; then
      HITF+=("$f")
    else
      MISSF+=("$f")
    fi
  done
  if [ "${#MISSF[@]}" -eq 0 ]; then
    ok "规则5 预算声明 '$tok' 3/3 份命中（${HITF[*]}）"
  else
    bad "规则5 预算声明 '$tok' 仅命中 ${#HITF[@]}/3 份（${HITF[*]:-无}）；缺: ${MISSF[*]}"
  fi
done

printf '\n'
printf 'canonical-check: %d pass, %d warn, %d fail\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
