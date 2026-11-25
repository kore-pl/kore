#!/usr/bin/env bash
# kore 前端首屏门禁（M2-D / G-03 / R4）
# 用法: bash scripts/frontend-check.sh
# 退出码: 首屏 gzip 超 300 KiB 或产物含 *.map/.vite/全量字体 → 1；否则 0
#        （「体积漂移告警」只打印 [WARN]、列出逐文件增量，不改退出码）
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

# ---- 体积漂移告警（WARN，不阻断；本条不是 G-03 红线）---------------------------
# G-03 只判 300 KiB 红线，红线以下的增长此前无人看守：e86b97c 一条「文案改名」提交
# 把他人 728 行概览实现带进首屏（app.js gzip 39163→49329，+10166 B），期间零报警，
# 到 533d938 才被撤回。故这里加一条非阻断告警，让漂移在 review 里可见。
#
# 基线语义：一份「已评审、来源写清」的首屏快照。当前 = 2026-11-25 把插件管理子系统
# 抽出到 /assets/plugins-view.js 之后的快照（合计 80387 B），它已含 f8b54a3 的概览交付；
# 比 805bf31 的旧基线 81528 B 低 1141 B，即「概览 +10.1 KiB / 抽取 -12.0 KiB」的净结果。
# 合法增长落地时，同轮把下面六个数字更新为新快照并在提交说明里写明来源；
# 不更新就会每次跑都 WARN——这正是设计意图：首屏变大必须有人签字，不能靠余量悄悄吃掉。
# 触发条件：合计 > 基线 +5%（当前 84406 B）或 > 绝对线 90000 B。
declare -A BASE_FILES=(
  [index.html]=1006 [style.css]=19422 [app.js]=38003
  [shell.js]=19015 [i18n.js]=1594 [i18n-zh-CN.js]=1347
)
BASE_TOTAL=0
for f in "${FILES[@]}"; do
  BASE_TOTAL=$((BASE_TOTAL + ${BASE_FILES[${f#"$DIST"/}]:-0}))
done
BASE_LIMIT=$((BASE_TOTAL * 105 / 100))
WARN_ABS=90000
if [ "$TOTAL" -gt "$BASE_LIMIT" ] || [ "$TOTAL" -gt "$WARN_ABS" ]; then
  printf '[WARN] 首屏体积漂移：%d 字节 > 基线+5%%（%d）或绝对线（%d）\n' "$TOTAL" "$BASE_LIMIT" "$WARN_ABS"
  printf '[WARN]   %-18s %8s %8s %8s %7s\n' 文件 当前 基线 增量 占比
  for f in "${FILES[@]}"; do
    name=${f#"$DIST"/}
    cur=$(gzip -9 -c "$f" | wc -c)
    base=${BASE_FILES[$name]:-0}
    printf '[WARN]   %-18s %8d %8d %+8d %6d%%\n' "$name" "$cur" "$base" "$((cur - base))" "$((cur * 100 / TOTAL))"
  done
  printf '[WARN] 处理口径：增长若是已评审的首屏必需功能（如概览页本体）→ 同轮更新脚本里的 BASE_FILES 快照并写来源；\n'
  printf '[WARN]           若是「本该懒加载却被塞进首屏」→ 拆回 /assets/<视图>.js 懒加载视图，再跑本条复核。\n'
else
  printf '[OK] 首屏体积无漂移告警：%d 字节 ≤ 基线+5%%（%d）\n' "$TOTAL" "$BASE_LIMIT"
fi


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
