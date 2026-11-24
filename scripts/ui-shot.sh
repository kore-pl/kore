#!/usr/bin/env bash
# ui-shot.sh — G-28 双端 UI 截图固化工具
#
# 一条命令完成：起隔离 kored 实例（config/state/run/log 全落 /tmp、独立端口）
# → healthz 就绪 → 注入登录态 → 路由存在性校验 → PC 1440x900 full-page / 手机 390x844
# → file/identify 实测宽高 → 停实例、删临时目录。
#
# 用法：scripts/ui-shot.sh --scene store --route store --desktop --mobile
# 退出码：0 成功 / 2 用法或依赖 / 3 构建 / 4 实例启动 / 5 登录 / 6 渲染 / 7 截图或宽高不符
set -euo pipefail

SCENE="" ROUTE="dashboard" OUT_DIR="" PORT="" BIN="" MOCK="" EXPECT_TEXT=""
SHOOT_DESKTOP=0 SHOOT_MOBILE=0 SETTLE=1200 KEEP=0
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

usage() {
  cat <<'EOF'
用法: scripts/ui-shot.sh --scene <name> --route <id> [--desktop] [--mobile] [选项]

必填:
  --scene <name>       场景名，产出 <scene>-desktop-01.png / <scene>-mobile-01.png
  --route <id>         hash 路由 id（不带 #/），如 dashboard / store / security/dns

截图端（都不给 = 双端）:
  --desktop            1440x900，full-page
  --mobile             390x844

选项:
  --out-dir <dir>      输出目录，默认 .agents/verify/screenshots
  --port <n>           首选端口；被占用时自动改选空闲端口（默认直接自动选）
  --binary <path>      指定 kored 二进制（跳过构建）
  --mock <file.json>   桩数据：[[{"url":"**/api/v1/x","status":200,"body":{...}}]]
  --expect-text <s>    截图前断言页面包含该文本（防截到登录页/空壳）
  --settle <ms>        路由渲染后额外等待，默认 1200
  --keep               保留 /tmp 临时目录（排障用）
  -h, --help           显示本帮助

反例语义:
  端口被占用   → 自动换端口继续，不失败
  实例起不来   → exit 4，打印 kored 日志尾部，不产出图片
  路由不存在   → exit 6，明确报「路由不存在/回落到 X」，不产出图片
EOF
}

die() { local code=$1; shift; echo "[FAIL] $*" >&2; exit "$code"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --scene) SCENE=${2:-}; shift 2 ;;
    --route) ROUTE=${2:-}; shift 2 ;;
    --desktop) SHOOT_DESKTOP=1; shift ;;
    --mobile) SHOOT_MOBILE=1; shift ;;
    --out-dir) OUT_DIR=${2:-}; shift 2 ;;
    --port) PORT=${2:-}; shift 2 ;;
    --binary) BIN=${2:-}; shift 2 ;;
    --mock) MOCK=${2:-}; shift 2 ;;
    --expect-text) EXPECT_TEXT=${2:-}; shift 2 ;;
    --settle) SETTLE=${2:-}; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die 2 "未知参数: $1" ;;
  esac
done

[ -n "$SCENE" ] || { usage >&2; die 2 "缺少 --scene"; }
[ -n "$ROUTE" ] || die 2 "缺少 --route"
if [ "$SHOOT_DESKTOP" -eq 0 ] && [ "$SHOOT_MOBILE" -eq 0 ]; then SHOOT_DESKTOP=1; SHOOT_MOBILE=1; fi
ROUTE=${ROUTE#\#/}; ROUTE=${ROUTE#/}; [ -n "$ROUTE" ] || ROUTE=dashboard
[ -n "$OUT_DIR" ] || OUT_DIR="$ROOT/.agents/verify/screenshots"
mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
[ -n "$MOCK" ] && { [ -f "$MOCK" ] || die 2 "mock 文件不存在: $MOCK"; MOCK=$(cd "$(dirname "$MOCK")" && pwd)/$(basename "$MOCK"); }

for t in curl python3 identify file tar; do command -v "$t" >/dev/null || die 2 "缺少依赖命令: $t"; done

TMP=$(mktemp -d "/tmp/kore-ui-shot.${SCENE}.XXXXXX") || die 2 "无法创建临时目录"
KORED_PID=""
cleanup() {
  local ec=$?
  trap - EXIT INT TERM
  if [ -n "$KORED_PID" ] && kill -0 "$KORED_PID" 2>/dev/null; then
    kill -TERM "$KORED_PID" 2>/dev/null || true
    for _ in $(seq 1 25); do kill -0 "$KORED_PID" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$KORED_PID" 2>/dev/null || true
    wait "$KORED_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" -eq 1 ]; then echo "[KEEP] 临时目录保留: $TMP" >&2; else rm -rf -- "$TMP"; fi
  exit "$ec"
}
trap cleanup EXIT INT TERM

# ── 1. 解析二进制：--binary > 工作树内容哈希缓存 > 从工作树归档构建 ──────────
list_tree() {
  git -C "$ROOT" ls-files -co --exclude-standard -z |
    while IFS= read -r -d '' f; do [ -e "$ROOT/$f" ] && printf '%s\0' "$f"; done
}
build_binary() {
  command -v go >/dev/null || die 3 "未找到 go（可用 --binary 指定 kored）"
  local src cache_dir cache tmp_bin
  cache_dir=/tmp/kore-ui-shot-cache; mkdir -p "$cache_dir"

  _build() { # $1=key $2=label $3=populate-fn
    cache="$cache_dir/kored-$1"
    [ -x "$cache" ] && { BIN="$cache"; return 0; }
    src="$TMP/src"; rm -rf "$src"; mkdir -p "$src"
    "$3" || return 1
    tmp_bin="$cache.build.$$"
    ( cd "$src" && make -s web-dist >/dev/null 2>&1 &&
      CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build -trimpath -buildvcs=false \
        -ldflags '-s -w' -o "$tmp_bin" ./cmd/kored ) >"$TMP/build.log" 2>&1 ||
      { tail -n 15 "$TMP/build.log" >&2; rm -f "$tmp_bin"; return 1; }
    mv -f "$tmp_bin" "$cache" 2>/dev/null || rm -f "$tmp_bin"
    BIN="$cache"; echo "[INFO] 构建来源: $2"
  }
  _populate_worktree() { list_tree | tar -C "$ROOT" --null -T - -cf - | tar -C "$src" -xf -; }
  _populate_head() { git -C "$ROOT" archive HEAD | tar -C "$src" -xf -; }

  if [ "${UI_SHOT_BUILD_SOURCE:-worktree}" = "head" ]; then
    _build "head-$(git -C "$ROOT" rev-parse --short=12 HEAD)" "HEAD 归档" _populate_head ||
      die 3 "kored 构建失败（HEAD 归档）"
    return 0
  fi

  local key
  key=$( { git -C "$ROOT" rev-parse HEAD
           git -C "$ROOT" status --porcelain
           git -C "$ROOT" diff HEAD
           list_tree | xargs -0 -r sha256sum 2>/dev/null
         } | sha256sum | cut -d' ' -f1 | cut -c1-16 )
  if _build "$key" "当前工作树" _populate_worktree; then return 0; fi
  echo "[WARN] 工作树存在无法编译的在途改动（多为其他 agent 半成品），回退 HEAD 归档构建" >&2
  echo "[WARN] 截图反映 HEAD 的 UI；如需包含未提交 UI 改动，先让工作树可编译或用 --binary" >&2
  _build "head-$(git -C "$ROOT" rev-parse --short=12 HEAD)" "HEAD 归档（回退）" _populate_head ||
    die 3 "kored 构建失败（工作树与 HEAD 均不可编译）"
}
if [ -z "$BIN" ]; then
  if [ -x "$ROOT/bin/kored" ] && [ "${UI_SHOT_PREFER_BINARY:-}" = "1" ]; then BIN="$ROOT/bin/kored"; else build_binary; fi
else
  [ -x "$BIN" ] || die 2 "二进制不可执行: $BIN"
fi
echo "[INFO] kored: $BIN"

# ── 2. 起隔离实例：独立端口 + /tmp 全落盘，端口占用自动重选 ─────────────────
free_port() {
  python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0))
print(s.getsockname()[1]); s.close()
PY
}
port_busy() { ! python3 - "$1" <<'PY'
import socket, sys
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}
write_config() {
  cat >"$TMP/config.yaml" <<EOF
server:
  addr: "127.0.0.1:$1"
auth:
  admin_password_hash: "${PW_HASH:-pbkdf2-sha256\$1000\$c2FsdA\$aGFzaA}"
  session_ttl: "2h"
  cookie_secure: "auto"
paths:
  state_dir: "$TMP/state"
  run_dir: "$TMP/run"
  log_dir: "$TMP/log"
  index_dir: "$IDX_DIR"
EOF
  chmod 600 "$TMP/config.yaml"
}
wait_health() {
  local port=$1 i
  for i in $(seq 1 100); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$port/-/healthz" >/dev/null 2>&1; then return 0; fi
    kill -0 "$KORED_PID" 2>/dev/null || return 1
    sleep 0.2
  done
  return 1
}
IDX_DIR=""
[ -d "$ROOT/../kore-plugins/index" ] && IDX_DIR=$(cd "$ROOT/../kore-plugins/index" && pwd)

PASSWORD=$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
# 口令哈希必须在起实例前写进配置：kored 只在启动时读 auth 段，起后再改不生效。
write_config 1 >/dev/null 2>&1 || true
cp "$TMP/config.yaml" "$TMP/seed.yaml"
printf '%s\n' "$PASSWORD" | "$BIN" admin-password --set --stdin --config "$TMP/seed.yaml" >"$TMP/admin-password.log" 2>&1 ||
  { echo "[FAIL] step=login 写入管理员口令失败" >&2; tail -n 5 "$TMP/admin-password.log" >&2; exit 5; }
PW_HASH=$(sed -n 's/^[[:space:]]*admin_password_hash:[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$TMP/seed.yaml" | head -1)
[ -n "$PW_HASH" ] || { echo "[FAIL] step=login 未能从配置读回口令哈希" >&2; exit 5; }
LISTEN_PORT=""
for attempt in 1 2 3 4 5; do
  if [ -n "$PORT" ] && [ "$attempt" -eq 1 ]; then
    if port_busy "$PORT"; then
      echo "[WARN] 端口 $PORT 被占用，自动改选空闲端口" >&2
      PORT=""
    fi
  fi
  [ -n "$PORT" ] || PORT=$(free_port)
  write_config "$PORT"
  : >"$TMP/kored.log"
  "$BIN" serve --config "$TMP/config.yaml" >"$TMP/kored.log" 2>&1 &
  KORED_PID=$!
  if wait_health "$PORT"; then LISTEN_PORT=$PORT; break; fi
  if grep -qiE "address already in use|bind|listen" "$TMP/kored.log"; then
    kill -KILL "$KORED_PID" 2>/dev/null || true; wait "$KORED_PID" 2>/dev/null || true
    KORED_PID=""; echo "[WARN] 端口 $PORT 绑定失败，换端口重试（attempt $attempt）" >&2; PORT=""
    continue
  fi
  echo "[FAIL] step=instance 隔离实例未就绪（healthz 超时）" >&2
  tail -n 20 "$TMP/kored.log" >&2
  exit 4
done
[ -n "$LISTEN_PORT" ] || { echo "[FAIL] step=instance 5 次换端口仍无法启动" >&2; tail -n 20 "$TMP/kored.log" >&2; exit 4; }
echo "[INFO] 隔离实例: pid=$KORED_PID port=$LISTEN_PORT"

# ── 3. 登录：写入已知口令 → API 登录拿 cookie（HttpOnly session + 可读 CSRF）──
LOGIN_JSON=$(curl -fsS -c "$TMP/cookies.txt" -X POST "http://127.0.0.1:$LISTEN_PORT/api/v1/auth/login" \
  -H 'Content-Type: application/json' --data "{\"password\":\"$PASSWORD\"}") ||
  { echo "[FAIL] step=login 登录接口失败（实例是否进入登录门？）" >&2; exit 5; }
case "$LOGIN_JSON" in
  *'"authenticated":true'*) ;;
  *) echo "[FAIL] step=login 登录未通过: $LOGIN_JSON" >&2; exit 5 ;;
esac
curl -fsS -b "$TMP/cookies.txt" "http://127.0.0.1:$LISTEN_PORT/api/v1/auth/session" >/dev/null ||
  { echo "[FAIL] step=login 会话校验失败" >&2; exit 5; }

# ── 4. Playwright 模块定位（已装环境，不引新依赖）──────────────────────────
PW_DIRS=()
[ -d "$ROOT/web/node_modules/playwright" ] && PW_DIRS+=("$ROOT/web/node_modules")
[ -d "$ROOT/node_modules/playwright" ] && PW_DIRS+=("$ROOT/node_modules")
while IFS= read -r d; do [ -n "$d" ] && PW_DIRS+=("$d"); done < <(
  for d in $(ls -d /home/pt/.npm/_npx/*/node_modules/playwright 2>/dev/null); do
    v=$(node -p "require('$d/package.json').version" 2>/dev/null || echo 0.0.0)
    printf '%s %s\n' "$v" "$(dirname "$d")"
  done | sort -rV | cut -d' ' -f2)
[ ${#PW_DIRS[@]} -gt 0 ] || die 2 "未找到 playwright 模块（npx playwright --version 可用吗？）"

cat >"$TMP/shot.mjs" <<'JS'
import fs from 'node:fs';
import { createRequire } from 'node:module';
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const require = createRequire(cfg.pwDir + '/');
const { chromium } = require('playwright');
const fail = (step, msg) => { console.error(`[FAIL] step=${step} ${msg}`); process.exit(6); };

function readCookies(jar) {
  const out = [];
  for (let line of fs.readFileSync(jar, 'utf8').split('\n')) {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10);
    else if (!line || line.startsWith('#')) continue;
    const p = line.split('\t');
    if (p.length < 7) continue;
    out.push({ name: p[5], value: p[6], domain: '127.0.0.1', path: '/', httpOnly: p[5] === 'kore_session' });
  }
  return out;
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height } });
  await ctx.addCookies(readCookies(cfg.cookieJar));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (cfg.mocks) {
    for (const m of cfg.mocks) {
      await page.route(m.url, route => route.fulfill({
        status: m.status || 200,
        contentType: m.contentType || 'application/json',
        body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
      }));
    }
  }
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    .catch(e => fail('goto', `页面打开失败: ${e.message}`));
  await page.waitForSelector('#kore-password, .kore-nav-item', { timeout: 20000 })
    .catch(() => fail('render', '登录门或主壳都未出现（页面白屏/JS 报错）'));
  if (await page.$('#kore-password')) fail('login', '落到登录页：cookie 未被接受（不截图、不产出黑图）');
  await page.waitForFunction(
    r => window.KoreShell && typeof window.KoreShell.current === 'function' && window.KoreShell.current() === r,
    cfg.route, { timeout: 15000 }
  ).catch(async () => {
    const cur = await page.evaluate(() => (window.KoreShell && window.KoreShell.current ? window.KoreShell.current() : null));
    fail('route', `路由 "${cfg.route}" 不存在或未渲染，当前回落到 "${cur}"`);
  });
  if (cfg.expectText) {
    await page.waitForFunction(
      t => document.body.innerText.includes(t), cfg.expectText, { timeout: 15000 }
    ).catch(() => fail('render', `页面未出现期望文本「${cfg.expectText}」`));
  }
  await page.waitForTimeout(cfg.settle);
  const view = await page.evaluate(() => {
    const v = document.querySelector('.view');
    return { view: v ? v.getAttribute('data-view') : null, nav: !!document.querySelector('.kore-nav-item') };
  });
  if (!view.nav) fail('render', '主壳导航未渲染');
  await page.screenshot({ path: cfg.out, fullPage: !!cfg.fullPage })
    .catch(e => fail('shot', `截图失败: ${e.message}`));
  if (errors.length) console.error(`[WARN] 页面 JS 错误: ${errors.slice(0, 3).join(' | ')}`);
  await browser.close();
} catch (e) {
  console.error(`[FAIL] step=shot ${e.message}`);
  try { await browser.close(); } catch {}
  process.exit(6);
}
JS

shot_one() {
  local kind=$1 width=$2 height=$3 full=$4 out="$OUT_DIR/${SCENE}-${1}-01.png"
  local cfg="$TMP/shot-$kind.json" pw="" ok=0
  local route_json; route_json=$(printf '%s' "$ROUTE" | sed 's/\\/\\\\/g; s/"/\\"/g')
  local expect_json="null"; [ -n "$EXPECT_TEXT" ] && expect_json=$(printf '%s' "$EXPECT_TEXT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')
  local mocks_json="null"
  if [ -n "$MOCK" ]; then
    python3 - "$MOCK" "$cfg" <<'PY'
import json, sys
rules = json.load(open(sys.argv[1], encoding='utf-8'))
if isinstance(rules, dict): rules = rules.get('mocks', [])
out = {"mocks": rules}
open(sys.argv[2] + '.mocks', 'w', encoding='utf-8').write(json.dumps(out))
PY
    mocks_json=$(python3 -c "import json,sys;print(json.dumps(json.load(open(sys.argv[1]))['mocks'],ensure_ascii=False))" "$cfg.mocks")
  fi
  rm -f "$out"
  for pw in "${PW_DIRS[@]}"; do
    [ -d "$pw/playwright" ] || continue
    cat >"$cfg" <<EOF
{"url":"http://127.0.0.1:$LISTEN_PORT/#/$route_json","out":"$out","width":$width,"height":$height,"fullPage":$full,"route":"$route_json","expectText":$expect_json,"settle":$SETTLE,"cookieJar":"$TMP/cookies.txt","pwDir":"$pw","mocks":$mocks_json}
EOF
    if NODE_PATH="$pw" node "$TMP/shot.mjs" "$cfg" 2>"$TMP/shot-$kind.err"; then ok=1; break; fi
    if grep -qiE "Executable doesn't exist|please run|Cannot find module" "$TMP/shot-$kind.err"; then
      echo "[WARN] playwright 不可用（$pw），换下一个候选" >&2
      continue
    fi
    cat "$TMP/shot-$kind.err" >&2
    exit 6
  done
  [ "$ok" -eq 1 ] || { cat "$TMP/shot-$kind.err" >&2; die 6 "所有 playwright 候选均不可用"; }
  [ -s "$out" ] || die 7 "截图文件未生成: $out"
  local dims w h
  dims=$(identify -format '%w %h' "$out" 2>/dev/null) || die 7 "identify 无法读取: $out"
  w=${dims% *}; h=${dims#* }
  if [ "$kind" = desktop ]; then
    [ "$w" = 1440 ] && [ "$h" -ge 900 ] || die 7 "PC 截图宽高不符: ${w}x${h}（要求宽 1440、高 ≥900）"
  else
    [ "$w" = 390 ] && [ "$h" = 844 ] || die 7 "手机截图宽高不符: ${w}x${h}（要求 390x844）"
  fi
  local bytes; bytes=$(stat -c '%s' "$out")
  echo "[OK] $kind ${w}x${h} ${bytes}B $out"
}

[ "$SHOOT_DESKTOP" -eq 1 ] && shot_one desktop 1440 900 true
[ "$SHOOT_MOBILE" -eq 1 ] && shot_one mobile 390 844 false
echo "[DONE] scene=$SCENE route=$ROUTE"
