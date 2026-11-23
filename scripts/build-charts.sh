#!/usr/bin/env bash
# kore 图表产物构建（FRONTEND §13 / ADR-0027）
# 用法: bash scripts/build-charts.sh
# 产出: web/dist/charts.js（运行时封装，ESM）与 web/dist/charts-echarts.js（vendor chunk，ESM）
# 退出码: 0 = 产物就绪（含"已是最新、跳过重建"）；1 = 缺源 / 缺 node / 依赖装不上 / esbuild 失败
#
# 设计要点：
# - **平铺**：两个产物直接落在 web/dist 根下。内核静态路由 /assets/{file} 只接受单段文件名
#   （internal/core/httpapi/server.go handleAsset 拒绝含 / 的路径），产物不能进子目录。
# - **幂等**：先比时间戳，源没变就不跑 esbuild；从 web/.cache/charts/（构建缓存，gitignore）
#   回填到 dist，因此 `make frontend` 整体重建 dist 后不需要重跑打包器。
# - **无 map**：不传 --sourcemap，收尾再断言 dist 里没有 *.map（G-03/R4 红线不放宽）。
# - **干净检出**：web/node_modules 缺失时按 web/package-lock.json 安装 devDependencies
#   （需要网络；之后离线可重复构建）。装不上就报 FAIL 并给出原因，不降级、不改用 CDN。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WEB="web"
ENTRY="$WEB/charts/echarts-entry.js"
WRAPPER="$WEB/charts.js"
PKG="$WEB/package.json"
LOCK="$WEB/package-lock.json"
CACHE="$WEB/.cache/charts"
DIST="$WEB/dist"
VENDOR_OUT="$CACHE/charts-echarts.js"
WRAPPER_OUT="$CACHE/charts.js"
ESBUILD="$WEB/node_modules/.bin/esbuild"

# esbuild 参数（两处共用）：ESM、压缩、UTF-8（中文提示不转 \\u 转义）、ES2020（动态 import 原生）、
# 显式钉死 NODE_ENV=production 以剥离 ECharts 的开发期断言分支（体积与行为都可复现）。
ESBUILD_COMMON=(--format=esm --minify --charset=utf8 --target=es2020 --platform=browser
  --define:process.env.NODE_ENV='"production"' --log-level=warning)

die() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
info() { printf '[INFO] %s\n' "$*"; }

for f in "$ENTRY" "$WRAPPER" "$PKG" "$LOCK"; do
  [ -f "$f" ] || die "缺少图表源文件或锁文件: $f"
done

mkdir -p "$CACHE" "$DIST"

# ── 1. 是否真的需要重建（幂等：只比时间戳，不调用 node）──
stale=0
if [ ! -f "$VENDOR_OUT" ] || [ ! -f "$WRAPPER_OUT" ]; then
  stale=1
elif [ -n "$(find "$WEB/charts" "$WRAPPER" "$PKG" "$LOCK" -type f -newer "$VENDOR_OUT" 2>/dev/null | head -n 1)" ]; then
  stale=1
elif [ "$WRAPPER" -nt "$WRAPPER_OUT" ]; then
  stale=1
fi

if [ "$stale" -eq 1 ]; then
  # ── 2. 工具链自检（只在真要构建时做，保持 make build 的常规路径快）──
  command -v node >/dev/null 2>&1 || die "未找到 node：图表构建需要 node ≥18（版本与依赖见 web/package.json）"
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 18 ] || die "node 版本过低（当前 $(node -v)，需要 ≥18）"

  if [ ! -x "$ESBUILD" ]; then
    command -v npm >/dev/null 2>&1 || die "缺 esbuild 且无 npm：请先装 node.js（含 npm），或在 web/ 下预装 devDependencies"
    info "首次构建：按 web/package-lock.json 安装 devDependencies（esbuild + echarts 源）"
    ( cd "$WEB" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error ) \
      || die "依赖安装失败（离线环境请预装 web/node_modules：esbuild@0.28.2 + echarts@5.6.0）"
  fi
  [ -x "$ESBUILD" ] || die "esbuild 不可用: $ESBUILD"

  # ── 3. 打包：唯一入口 echarts-entry.js 树摇成 vendor chunk ──
  info "esbuild 打包 $(basename "$ENTRY") → ${VENDOR_OUT#"$ROOT"/}"
  "$ESBUILD" "$ENTRY" --bundle "${ESBUILD_COMMON[@]}" --outfile="$VENDOR_OUT" \
    || die "vendor chunk 打包失败"
  # 运行时封装单独压缩（不 bundle：动态 import 的相对路径必须保持原样，懒加载链才成立）
  info "esbuild 压缩 $(basename "$WRAPPER") → ${WRAPPER_OUT#"$ROOT"/}"
  "$ESBUILD" "$WRAPPER" "${ESBUILD_COMMON[@]}" --outfile="$WRAPPER_OUT" \
    || die "charts.js 压缩失败"
else
  info "图表产物已是最新（源未变更），跳过 esbuild"
fi

# ── 4. 回填 dist（平铺在根；make frontend 重建 dist 后也靠这一步）──
cp "$VENDOR_OUT" "$DIST/charts-echarts.js"
cp "$WRAPPER_OUT" "$DIST/charts.js"

# ── 5. 收尾断言：禁 map、禁子目录、ESM 形状、懒加载链完整 ──
maps="$(find "$DIST" -maxdepth 2 -name '*.map' 2>/dev/null || true)"
[ -z "$maps" ] || die "dist 出现 source map（红线 *.map 禁令）: $maps"
[ ! -d "$DIST/charts" ] || die "产物不能进子目录（/assets/{file} 只接受单段文件名）"

grep -q 'charts-echarts\.js' "$DIST/charts.js" \
  || die "charts.js 里找不到 charts-echarts.js 的懒加载入口（动态 import 链断了）"
grep -q 'export' "$DIST/charts.js" || die "dist/charts.js 不是 ESM 产物（缺 export）"
grep -q 'export' "$DIST/charts-echarts.js" || die "dist/charts-echarts.js 不是 ESM 产物（缺 export）"

vendor_raw="$(stat -c%s "$DIST/charts-echarts.js")"
vendor_gz="$(gzip -9 -c "$DIST/charts-echarts.js" | wc -c)"
wrap_raw="$(stat -c%s "$DIST/charts.js")"
wrap_gz="$(gzip -9 -c "$DIST/charts.js" | wc -c)"
printf '[OK] 图表产物就绪: dist/charts-echarts.js %d 字节（gzip -9 %d）· dist/charts.js %d 字节（gzip -9 %d）\n' \
  "$vendor_raw" "$vendor_gz" "$wrap_raw" "$wrap_gz"
