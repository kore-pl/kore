#!/usr/bin/env bash
# 零侵入门禁（ADR-0023 §3.6）：在隔离实例上验证"删除安装目录即卸载"。
#
# 判定分三类：
#   1) FAIL：系统路径新增（/etc/kore、/var/lib/kore、/var/log/kore、/run/kore）、
#            新增 kore-<id> 用户/组、新增 kore systemd unit；
#   2) PASS：portable 目录（data/run/logs）与 socket 全部落在隔离安装目录内；
#   3) INFO：运行前已存在的 kore 用户/unit——属 ADR-0023 §3.5 豁免项，允许存在、不算 FAIL。
#
# 隔离手段（G-29）：临时安装根 + 不用 `--config`（走 portable 默认路径）+ 不用 KORE_HOME
# （让 <install> 由可执行文件位置推导，正好验证默认值），全程不碰主实例与 /etc、/var。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 隔离根落在工作区内（G-29：不写真实 <install>/data、不碰 .kore-local-*）。
TMP="$(mktemp -d "$ROOT/.zero-intrusion-tmp.XXXXXX")" || { echo "[FAIL] 无法创建临时安装目录"; exit 1; }
PID=""
PASS=0
FAIL=0
INFO=0

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
    kill -KILL "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [ "${KORE_ZERO_INTRUSION_KEEP:-0}" = "1" ]; then
    echo "[INFO] 保留临时目录（KORE_ZERO_INTRUSION_KEEP=1）：$TMP"
  else
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); echo "[PASS] $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "[FAIL] $*"; }
info() { INFO=$((INFO + 1)); echo "[INFO] $*"; }

# 系统路径快照：只记录"存在性 + 类型"，用于前后对比。
snapshot_paths() {
  for p in /etc/kore /var/lib/kore /var/log/kore /run/kore; do
    if [ -e "$p" ]; then echo "present $p"; fi
  done
}
snapshot_users() { getent passwd 2>/dev/null | awk -F: '$1 ~ /^kore-/ {print $1}' | sort; }
snapshot_groups() { getent group 2>/dev/null | awk -F: '$1 ~ /^kore-/ {print $1}' | sort; }
snapshot_units() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl list-unit-files 2>/dev/null | awk '{print $1}' | grep -E '^kore' | sort || true
  fi
}

BEFORE_PATHS="$(snapshot_paths)"
BEFORE_USERS="$(snapshot_users)"
BEFORE_GROUPS="$(snapshot_groups)"
BEFORE_UNITS="$(snapshot_units)"

echo "[INFO] 隔离安装根：$TMP（不设 KORE_HOME / --config，验证 portable 默认推导）"
# web/dist 是 gitignored 构建产物（//go:embed 依赖）；干净检出先补齐再编译。
make web-dist >/dev/null 2>&1 || true
echo "[INFO] 构建隔离二进制：$TMP/bin/kored"
if ! CGO_ENABLED=0 go build -trimpath -buildvcs=false -o "$TMP/bin/kored" ./cmd/kored 2>"$TMP/build.log"; then
  bad "构建 kored 失败（见 $TMP/build.log）"
  exit 1
fi
ok "构建隔离二进制（<install>/bin/kored）"

# 环境清零：确保走默认值，且不继承主实例/开发实例的覆盖。
UNSET_ENV=(env -u KORE_HOME -u KORE_PROFILE -u KORE_CONFIG -u KORE_STATE_DIR -u KORE_PLUGIN_DIR)
"${UNSET_ENV[@]}" "$TMP/bin/kored" serve >"$TMP/serve.log" 2>&1 &
PID=$!

SOCK="$TMP/run/kore.sock"
READY=0
for _ in $(seq 1 100); do
  if [ -S "$SOCK" ]; then READY=1; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.1
done
if [ "$READY" != "1" ]; then
  bad "隔离实例未在 10s 内就绪（socket=$SOCK）"
  echo "----- serve.log（尾部 20 行）-----"
  tail -n 20 "$TMP/serve.log" 2>/dev/null || true
  exit 1
fi
ok "隔离实例就绪，socket 落在安装目录内：$SOCK"

HEALTH="$(curl -s -o /dev/null -w '%{http_code}' --unix-socket "$SOCK" http://localhost/-/healthz 2>/dev/null || true)"
if [ "$HEALTH" = "200" ]; then ok "UDS /-/healthz = 200"; else info "UDS /-/healthz 返回 '$HEALTH'（不影响零侵入判定）"; fi

# portable 目录断言
for d in data run logs; do
  if [ -d "$TMP/$d" ]; then ok "portable 目录已创建：<install>/$d"; else bad "portable 目录缺失：<install>/$d"; fi
done
if [ -f "$TMP/data/state.db" ]; then ok "状态库落在 <install>/data/state.db"; else info "未发现 <install>/data/state.db（可能尚未写入，不影响判定）"; fi

# ---- ADR-0023 §11 追加判据：本地更新状态文件（豁免 #5）----
# 状态文件不随 serve 自动产生（写入点由 M6 更新链接入）；用专用夹具在隔离目录
# 写一次，验证 0600 + 账本 file.remove + 白名单回滚，全程不碰真实 <install>/data。
ZI_STATE="$TMP/zi-state"
mkdir -p "$ZI_STATE"
if KORE_ZI_STATE_DIR="$ZI_STATE" GOCACHE="$TMP/gocache" CGO_ENABLED=0 \
    go test -count=1 -run '^TestZeroIntrusionFixture$' ./cmd/kored >"$TMP/zi-fixture.log" 2>&1; then
  ok "隔离实例写入状态文件（隔离目录 $ZI_STATE，不碰真实 <install>/data）"
else
  bad "隔离状态文件夹具失败（见 $TMP/zi-fixture.log）"
  tail -n 20 "$TMP/zi-fixture.log" 2>/dev/null || true
fi

STATE_FILE="$ZI_STATE/update-state.json"
LEDGER="$ZI_STATE/changes.jsonl"
if [ -f "$STATE_FILE" ]; then
  MODE="$(stat -c '%a' "$STATE_FILE" 2>/dev/null || echo '?')"
  if [ "$MODE" = "600" ]; then ok "状态文件权限 0600（实际 $MODE）"; else bad "状态文件权限 = $MODE，要求 0600"; fi
  # 每系统仅此一个文件：隔离状态目录内不得有第二个 update-state* 或状态目录树
  STATE_COUNT="$(find "$ZI_STATE" -maxdepth 1 -name 'update-state*' | wc -l)"
  if [ "$STATE_COUNT" -eq 1 ]; then ok "全系统仅一个更新状态文件（实际 $STATE_COUNT 个）"; else bad "状态文件数量 = $STATE_COUNT，要求 1"; fi
else
  bad "状态文件未生成：$STATE_FILE"
fi
if [ -f "$LEDGER" ]; then
  if grep -q '"kind"[[:space:]]*:[[:space:]]*"file.remove"' "$LEDGER" && grep -q 'update-state.json' "$LEDGER"; then
    ok "账本含该状态文件的 file.remove 条目（有状态文件 ⟹ 可回滚）"
  else
    bad "账本缺少指向状态文件的 file.remove 条目"
  fi
  LEDGER_MODE="$(stat -c '%a' "$LEDGER" 2>/dev/null || echo '?')"
  if [ "$LEDGER_MODE" = "600" ]; then ok "账本权限 0600"; else bad "账本权限 = $LEDGER_MODE，要求 0600"; fi
else
  bad "账本未生成：$LEDGER"
fi

# 卸载后状态文件不存在：用账本里的 file.remove 逐条删除（幂等），再断言文件消失。
# 这里只删隔离目录内的文件，等价于 kore uninstall --purge 对该条目的处理。
if [ -f "$STATE_FILE" ] && [ -f "$LEDGER" ]; then
  TARGET="$(grep 'file.remove' "$LEDGER" | grep 'update-state.json' | tail -1 | sed -n 's/.*"args"[[:space:]]*:[[:space:]]*\["\([^"]*\)"\].*/\1/p')"
  if [ -n "$TARGET" ] && [ "$TARGET" = "$STATE_FILE" ]; then
    rm -f "$TARGET"
    if [ ! -e "$STATE_FILE" ]; then ok "按账本回滚后状态文件不存在（uninstall --purge 语义）"; else bad "回滚后状态文件仍存在"; fi
  else
    bad "无法从账本解析 file.remove 目标（target=$TARGET，期望 $STATE_FILE）"
  fi
fi

# 系统路径：新增即 FAIL；原有只记录（豁免项）
AFTER_PATHS="$(snapshot_paths)"
NEW_PATHS="$(comm -13 <(printf '%s\n' "$BEFORE_PATHS" | sed '/^$/d') <(printf '%s\n' "$AFTER_PATHS" | sed '/^$/d') || true)"
if [ -n "$NEW_PATHS" ]; then
  bad "本轮在系统路径下新建了目录：$(printf '%s' "$NEW_PATHS" | tr '\n' ' ')"
else
  ok "系统路径零新增（/etc/kore、/var/lib/kore、/var/log/kore、/run/kore）"
fi
if [ -n "$BEFORE_PATHS" ]; then
  info "运行前已存在的系统路径（属既有安装，本脚本不判定）：$(printf '%s' "$BEFORE_PATHS" | tr '\n' ' ')"
fi

# 用户/组：新增即 FAIL；原有 = 豁免 #2
AFTER_USERS="$(snapshot_users)"
NEW_USERS="$(comm -13 <(printf '%s\n' "$BEFORE_USERS" | sed '/^$/d') <(printf '%s\n' "$AFTER_USERS" | sed '/^$/d') || true)"
if [ -n "$NEW_USERS" ]; then
  bad "本轮新建了系统用户：$(printf '%s' "$NEW_USERS" | tr '\n' ' ')"
else
  ok "未新建 kore-* 系统用户（portable 非 root 实例不应建）"
fi
AFTER_GROUPS="$(snapshot_groups)"
NEW_GROUPS="$(comm -13 <(printf '%s\n' "$BEFORE_GROUPS" | sed '/^$/d') <(printf '%s\n' "$AFTER_GROUPS" | sed '/^$/d') || true)"
if [ -n "$NEW_GROUPS" ]; then bad "本轮新建了系统组：$(printf '%s' "$NEW_GROUPS" | tr '\n' ' ')"; else ok "未新建 kore-* 系统组"; fi
if [ -n "$BEFORE_USERS" ] || [ -n "$BEFORE_GROUPS" ]; then
  info "运行前已存在的 kore-* 用户/组（ADR-0023 §3.5 豁免 #2，允许存在；清理走 kore uninstall）：$(printf '%s' "$BEFORE_USERS $BEFORE_GROUPS" | tr '\n' ' ')"
fi

# systemd unit：新增即 FAIL；原有 = 豁免 #1
AFTER_UNITS="$(snapshot_units)"
NEW_UNITS="$(comm -13 <(printf '%s\n' "$BEFORE_UNITS" | sed '/^$/d') <(printf '%s\n' "$AFTER_UNITS" | sed '/^$/d') || true)"
if [ -n "$NEW_UNITS" ]; then
  bad "本轮新建了 systemd unit：$(printf '%s' "$NEW_UNITS" | tr '\n' ' ')"
else
  ok "未新建 kore systemd unit"
fi
if [ -n "$BEFORE_UNITS" ]; then
  info "运行前已存在的 kore unit（ADR-0023 §3.5 豁免 #1，允许存在）：$(printf '%s' "$BEFORE_UNITS" | tr '\n' ' ')"
fi

# 主实例隔离：确认本脚本没有碰 8787 / 主实例（只读探测）
if [ -n "${KORE_MAIN_SOCKET:-}" ] && [ -S "${KORE_MAIN_SOCKET}" ]; then
  if [ "$KORE_MAIN_SOCKET" = "$SOCK" ]; then bad "隔离 socket 与主实例相同"; fi
fi

echo ""
echo "zero-intrusion-check: $PASS pass, $INFO info, $FAIL fail（隔离根 $TMP）"
if [ "$FAIL" -gt 0 ]; then
  echo "结果: 门禁未通过（$FAIL FAIL）"
  exit 1
fi
echo "结果: 门禁通过（零侵入：安装目录外零新增；豁免项仅作说明）"
exit 0
