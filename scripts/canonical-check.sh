#!/usr/bin/env bash
# canonical-check — 口径唯一性门禁（现役数字只能有一个版本）
# 范围：AGENTS.md / README.md / docs/*.md（顶层文档）
# 排除：docs/DECISIONS/ —— ADR 允许记录"被拒备选 / 旧值"，不参与现役口径判定
# 退出码：存在 FAIL → 1；全部通过 → 0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
FAIL=0

ok()     { PASS=$((PASS + 1)); printf '[OK] %s\n' "$*"; }
bad()    { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$*"; }
detail() { printf '       %s\n' "$*"; }

# ---- 文件集：AGENTS.md + README.md + docs/*.md（不含子目录，因此 DECISIONS 天然排除）----
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

# 禁用词规则：零命中，命中则打印 文件:行号:内容（最多 10 行）
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

forbid "规则1 旧预算 48 MiB"                    '48 MiB'
forbid "规则2 默认 GOGC=200"                   'GOGC=200'
forbid "规则3 旧字段 type: resident|oneshot"   'type:[[:space:]]*(resident|oneshot)'
forbid "规则4 幽灵插件 id edge(/gateway(/sec(" '(^|[^[:alnum:]_])(edge|gateway|sec)\('

# 规则5：预算声明不得丢失 —— 三份口径文件【每份】都必须含每个关键值（不允许集合内凑数）
CANON=(AGENTS.md docs/RESOURCE-MODEL.md docs/V1-GOALS.md)
for f in "${CANON[@]}"; do
  if [ ! -f "$f" ]; then
    bad "规则5 口径文件缺失: $f"
  fi
done
for tok in '24 MiB' '12 MiB' '推荐 ≤2'; do
  hit_files=()
  miss_files=()
  for f in "${CANON[@]}"; do
    if [ -f "$f" ] && grep -qF -- "$tok" "$f"; then
      hit_files+=("$f")
    else
      miss_files+=("$f")
    fi
  done
  if [ "${#miss_files[@]}" -eq 0 ]; then
    ok "规则5 预算声明 '$tok' 3/3 份命中（${hit_files[*]}）"
  else
    bad "规则5 预算声明 '$tok' 仅命中 ${#hit_files[@]}/3 份（${hit_files[*]:-无}）；缺: ${miss_files[*]}"
  fi
done

printf '\n'
printf 'canonical-check: %d pass, %d fail\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
