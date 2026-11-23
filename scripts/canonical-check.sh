#!/usr/bin/env bash
# canonical-check — 口径唯一性门禁（现役数字只能有一个版本）
# 规则1 ：48 MiB 只允许与「红线」同行（ADR-0016 起 48 MiB = 常驻合计硬红线）
# 规则1b：目标语境的 MiB 值不得 >24（48 出现在目标语境即旧口径残留）
# 规则1c：合计语境的红线不得写成 24 MiB（24 是目标，不是红线）—— WARN
# 规则2 ：运行时默认 GOGC / GOMEMLIMIT / GOMAXPROCS == ADR-0015 规定值（校验实际值，不拦魔数；ADR 改则门禁跟着改）
# 规则2b：GOGC=200 字面量零命中（文档不得把对照档写成默认档）
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

# ---------------- 规则2：运行时锚点默认值 == ADR 规定值（不拦魔数） ----------------
# 口径真源：ADR-0015「运行时默认改为 GOGC=50、GOMEMLIMIT=6MiB、GOMAXPROCS=8」。
# ADR-0016 只定预算红线/目标（16/8 MiB 等），不写 GOGC 默认值——GOGC 的 ADR 真源是 0015。
# 断言：从 ADR 解析期望值、从代码常量解析实际值，两者必须相等。
#   ADR 改 → 期望值跟着改；代码漂了（默认值被改成 100/200）→ FAIL。
# 历史缺口：旧规则只 forbid 字面量 `GOGC=200`，拦不到 Makefile 写 `GOGC=100` 而代码实为 50 的漂移。
ADR_ANCHORS="docs/DECISIONS/0015-runtime-resource-anchors.md"
LIMITS_GO="cmd/kored/serve_limits.go"
MAKEFILE_CONTRACT=$(grep -m1 '^# 契约' Makefile 2>/dev/null || true)

adr_default() { # $1=GOGC|GOMEMLIMIT|GOMAXPROCS：从 ADR 决策句解析期望值（纯数字，MiB 去掉单位）
  printf '%s\n' "$ADR_LINE" | grep -oE "$1=[0-9]+(MiB)?" | head -1 | sed -E "s/^$1=//; s/MiB$//"
}

if [ ! -f "$ADR_ANCHORS" ]; then
  bad "规则2 找不到 ADR-0015（运行时锚点真源）: $ADR_ANCHORS"
elif [ ! -f "$LIMITS_GO" ]; then
  bad "规则2 找不到运行时锚点实现: $LIMITS_GO"
else
  ADR_LINE=$(grep -m1 '运行时默认改为' "$ADR_ANCHORS" || true)
  EXPECT_GOGC=$(adr_default GOGC || true)
  EXPECT_MEM=$(adr_default GOMEMLIMIT || true)
  EXPECT_PROCS=$(adr_default GOMAXPROCS || true)
  ACT_GOGC=$(grep -oE 'defaultGOGC[[:space:]]*=[[:space:]]*[0-9]+' "$LIMITS_GO" | head -1 | grep -oE '[0-9]+$' || true)
  ACT_MEM=$(grep -oE 'defaultMemLimit[[:space:]]+int64[[:space:]]*=[[:space:]]*[0-9]+' "$LIMITS_GO" | head -1 | grep -oE '[0-9]+$' || true)
  ACT_PROCS=$(grep -oE 'maxProcs[[:space:]]*=[[:space:]]*[0-9]+' "$LIMITS_GO" | head -1 | grep -oE '[0-9]+$' || true)

  PARSE_FAIL=0
  if [ -z "$EXPECT_GOGC" ] || [ -z "$EXPECT_MEM" ] || [ -z "$EXPECT_PROCS" ]; then
    bad "规则2 无法从 ADR-0015 解析默认锚点（fail-closed）：GOGC='${EXPECT_GOGC}' GOMEMLIMIT='${EXPECT_MEM:-?}MiB' GOMAXPROCS='${EXPECT_PROCS}'"
    PARSE_FAIL=1
  fi
  if [ -z "$ACT_GOGC" ] || [ -z "$ACT_MEM" ] || [ -z "$ACT_PROCS" ]; then
    bad "规则2 无法从 ${LIMITS_GO} 解析实际锚点常量（fail-closed）"
    PARSE_FAIL=1
  fi

  if [ "$PARSE_FAIL" -eq 0 ]; then
    for pair in "GOGC:${ACT_GOGC}:${EXPECT_GOGC}" "GOMEMLIMIT:${ACT_MEM}:${EXPECT_MEM}" "GOMAXPROCS:${ACT_PROCS}:${EXPECT_PROCS}"; do
      name=${pair%%:*}; rest=${pair#*:}; act=${rest%%:*}; exp=${rest#*:}
      if [ "$act" = "$exp" ]; then
        ok "规则2 运行时默认 ${name}=${act} == ADR-0015 规定值"
      else
        bad "规则2 运行时默认 ${name}=${act} != ADR-0015 规定的 ${exp}（改代码或改 ADR；ADR 是真源）"
      fi
    done

    MF_GOGC=$(printf '%s\n' "$MAKEFILE_CONTRACT" | grep -oE 'GOGC=[0-9]+' | head -1 | cut -d= -f2 || true)
    MF_MEM=$(printf '%s\n' "$MAKEFILE_CONTRACT" | grep -oE 'GOMEMLIMIT=[0-9]+MiB' | head -1 | sed -E 's/^GOMEMLIMIT=([0-9]+)MiB$/\1/' || true)
    if [ -z "$MF_GOGC" ] || [ -z "$MF_MEM" ]; then
      warn "规则2 Makefile 契约行未声明 GOGC=值 / GOMEMLIMIT=值（Makefile:3 是门禁入口注释）"
    else
      if [ "$MF_GOGC" = "$EXPECT_GOGC" ]; then
        ok "规则2 Makefile 契约行 GOGC=${MF_GOGC} 与 ADR-0015 一致"
      else
        bad "规则2 Makefile 契约行 GOGC=${MF_GOGC} 与 ADR-0015 规定的 ${EXPECT_GOGC} 不一致（2026-11-24 漂移：注释写 100，实际 50）"
      fi
      if [ "$MF_MEM" = "$EXPECT_MEM" ]; then
        ok "规则2 Makefile 契约行 GOMEMLIMIT=${MF_MEM}MiB 与 ADR-0015 一致"
      else
        bad "规则2 Makefile 契约行 GOMEMLIMIT=${MF_MEM}MiB 与 ADR-0015 规定的 ${EXPECT_MEM}MiB 不一致"
      fi
    fi
  fi
fi

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

forbid "规则2b GOGC=200 字面量"                'GOGC=200'
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
