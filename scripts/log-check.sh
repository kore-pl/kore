#!/usr/bin/env bash
# log-check — 判断留痕台账检查（WARN 级：任何情况都 exit 0，不阻断代码提交）
# 检查：.agents/LOG 三件套存在 / 表头字段 / 条目规模 / sessions 命名
# 里程碑收口时由人工按条目缺口判定；本脚本只负责"发现台账没建或字段缺"
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG=".agents/LOG"

PASS=0
WARN=0

ok()     { PASS=$((PASS + 1)); printf '[OK] %s\n' "$*"; }
warn()   { WARN=$((WARN + 1)); printf '[WARN] %s\n' "$*"; }
detail() { printf '       %s\n' "$*"; }

# ---------------- 1) 三件套存在 ----------------
for f in README.md DECISIONS.md DISPATCH.md; do
  if [ -f "$LOG/$f" ]; then
    ok "台账存在: $LOG/$f"
  else
    warn "台账缺失: $LOG/$f"
  fi
done

# ---------------- 2) 表头字段 ----------------
# check_header <文件> <必需列（空格分隔）>
check_header() {
  local file="$1"
  local cols="$2"
  local hdr miss c
  if [ ! -f "$LOG/$file" ]; then
    warn "$file 不存在，表头检查跳过"
    return 0
  fi
  hdr=$(grep -m1 -E '^[[:space:]]*\|' "$LOG/$file" 2>/dev/null || true)
  if [ -z "$hdr" ]; then
    warn "$file 未找到表头行（应以 | 开头）"
    return 0
  fi
  miss=""
  for c in $cols; do
    case "$hdr" in
      *"$c"*) : ;;
      *) miss="$miss $c" ;;
    esac
  done
  if [ -z "$miss" ]; then
    ok "$file 表头含必需列: $(printf '%s' "$cols" | tr ' ' '/')"
  else
    warn "$file 表头缺列:$miss"
  fi
}

check_header "DECISIONS.md" "议题 选项 裁决 依据"
check_header "DISPATCH.md" "task owner 写域 依赖 commit"

# ---------------- 3) 条目规模 ----------------
# count_rows <文件>：跳过表头行与 |---| 分隔行，统计数据行
count_rows() {
  local file="$1"
  if [ ! -f "$LOG/$file" ]; then
    printf '0\n'
    return 0
  fi
  awk '
    /^[[:space:]]*\|/ {
      if ($0 ~ /---/) next
      if (hdr == 0) { hdr = 1; next }
      c++
    }
    END { print c + 0 }
  ' "$LOG/$file"
}

ND=$(count_rows "DECISIONS.md")
if [ "$ND" -ge 10 ]; then
  ok "DECISIONS 条目 ${ND} ≥ 10"
else
  warn "DECISIONS 条目 ${ND} < 10（M1 期间实际规模）"
fi

NP=$(count_rows "DISPATCH.md")
if [ "$NP" -ge 10 ]; then
  ok "DISPATCH 条目 ${NP} ≥ 10"
else
  warn "DISPATCH 条目 ${NP} < 10（M1 期间实际规模）"
fi

# ---------------- 4) sessions 命名 ----------------
SESS_TOTAL=0
SESS_VALID=0
if [ -d "$LOG/sessions" ]; then
  for f in "$LOG"/sessions/*.md; do
    if [ ! -e "$f" ]; then
      continue
    fi
    SESS_TOTAL=$((SESS_TOTAL + 1))
    b=$(basename "$f")
    if [[ "$b" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-.+\.md$ ]]; then
      SESS_VALID=$((SESS_VALID + 1))
    fi
  done
fi

if [ "$SESS_VALID" -ge 1 ]; then
  ok "sessions/ 有 ${SESS_VALID}/${SESS_TOTAL} 个文件符合 YYYY-MM-DD-*.md"
else
  warn "sessions/ 无符合 YYYY-MM-DD-*.md 的文件（共 ${SESS_TOTAL} 个）"
fi

printf '\n'
printf 'log-check: %d pass, %d warn\n' "$PASS" "$WARN"
# 台账检查不阻断提交：任何情况都 exit 0
exit 0
