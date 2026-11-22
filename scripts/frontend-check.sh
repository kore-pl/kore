#!/usr/bin/env bash
# kore 前端首屏门禁（M2-D / G-03 / R4）
# 用法: bash scripts/frontend-check.sh
# 退出码: 首屏 gzip 超 300 KiB 或产物含 *.map/.vite/全量字体 → 1；否则 0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DIST="web/dist"
BUDGET=307200  # 300 KiB，来自 FRONTEND.md §7 / G-03

if [ ! -d "$DIST" ]; then
  printf '[FAIL] 产物目录不存在: %s\n' "$DIST"
  exit 1
fi

# R4：dist 不得含 source map / .vite 中间产物 / 全量字体
JUNK=$(find "$DIST" -type f \( -name '*.map' -o -path '*/.vite/*' -o -name '*.woff' -o -name '*.woff2' -o -name '*.ttf' -o -name '*.otf' \) 2>/dev/null | sort || true)
if [ -n "$JUNK" ]; then
  printf '[FAIL] dist 含禁止产物（*.map / .vite / 全量字体）:\n'
  printf '%s\n' "$JUNK" | sed 's/^/       /'
  exit 1
fi
printf '[OK] dist 无 source map / .vite / 全量字体\n'

# 首屏三件套：index.html + style.css + app.js，按 gzip -9 合计
FILES=("$DIST/index.html" "$DIST/style.css" "$DIST/app.js")
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    printf '[FAIL] 首屏文件缺失: %s\n' "$f"
    exit 1
  fi
done

TOTAL=0
for f in "${FILES[@]}"; do
  bytes=$(gzip -9 -c "$f" | wc -c)
  printf '[INFO] %-24s gzip -9: %6d 字节\n' "${f#$DIST/}" "$bytes"
  TOTAL=$((TOTAL + bytes))
done

printf '[INFO] 首屏合计（gzip -9）: %d 字节 / 预算 %d 字节（300 KiB）\n' "$TOTAL" "$BUDGET"
if [ "$TOTAL" -gt "$BUDGET" ]; then
  printf '[FAIL] 首屏超预算 %d 字节（G-03 红线）\n' "$((TOTAL - BUDGET))"
  exit 1
fi
printf '[OK] 首屏体积达标：%d 字节 ≤ %d 字节，余量 %d 字节\n' "$TOTAL" "$BUDGET" "$((BUDGET - TOTAL))"
exit 0
