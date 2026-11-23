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

# 首屏六件套：index.html + style.css + app.js + shell.js + i18n.js + i18n-zh-CN.js，
# 按 gzip -9 合计。shell.js 是布局壳（侧栏导航 + 视图路由），i18n.js 与中文文案表
# 是导航首屏渲染的输入，三者与 app.js 同批同步加载，故一并计入首屏；
# store.js / monitor.js / settings.js 等视图模块按需注入（web/app.js 的 ensureModule），
# 不计首屏——首屏体积不随视图数增长（FRONTEND §7：d(首屏)/d(视图数)=0）。
FILES=("$DIST/index.html" "$DIST/style.css" "$DIST/app.js" "$DIST/shell.js" "$DIST/i18n.js" "$DIST/i18n-zh-CN.js")
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

# i18n 增量（ADR-0021）：i18n.js + i18n-zh-CN.js 合计 gzip ≤ 3 KiB（3072 字节）。
# 独立于 300 KiB 总预算：语言骨架不能靠总预算的余量悄悄膨胀。
I18N_BUDGET=3072
I18N_TOTAL=0
for f in "$DIST/i18n.js" "$DIST/i18n-zh-CN.js"; do
  if [ ! -f "$f" ]; then
    printf '[FAIL] i18n 文件缺失: %s\n' "${f#$DIST/}"
    exit 1
  fi
  bytes=$(gzip -9 -c "$f" | wc -c)
  printf '[INFO] %-24s gzip -9: %6d 字节\n' "${f#$DIST/}" "$bytes"
  I18N_TOTAL=$((I18N_TOTAL + bytes))
done
printf '[INFO] i18n 增量（gzip -9）: %d 字节 / 预算 %d 字节（3 KiB）\n' "$I18N_TOTAL" "$I18N_BUDGET"
if [ "$I18N_TOTAL" -gt "$I18N_BUDGET" ]; then
  printf '[FAIL] i18n 骨架超预算 %d 字节（ADR-0021）\n' "$((I18N_TOTAL - I18N_BUDGET))"
  exit 1
fi
printf '[OK] i18n 增量达标：%d 字节 ≤ %d 字节，余量 %d 字节\n' "$I18N_TOTAL" "$I18N_BUDGET" "$((I18N_BUDGET - I18N_TOTAL))"
exit 0
