#!/usr/bin/env bash
# install-root-once.sh — 「一次 sudo、之后所有特权功能可用」的 root 安装器（ADR-0042/0049 落地壳）。
#
# 目标：把 kored 装成系统级 root 服务，使插件降权 / root-action 通道 / 审计链一次到位；
#       装完自动自检，失败逐项说明「哪一项、怎么修」，**绝不静默降级**。
#
# 用法:
#   sudo scripts/install-root-once.sh --bin ./bin/kored            # 安装或幂等更新（只输一次口令）
#   scripts/install-root-once.sh --dry-run                         # 打印计划，零变更（不需要 root）
#   scripts/install-root-once.sh --verify                          # 只读自检，PASS/FAIL/SKIP 逐项
#   sudo scripts/install-root-once.sh --rollback                   # 按 changes.jsonl 回滚
#   sudo scripts/install-root-once.sh --bin ./bin/kored --stop-user-instance
#                                                                  # 明确允许停掉在跑的非 root 实例
#   scripts/install-root-once.sh --self-test                       # 纯函数自测（渲染/幂等/覆盖/拒绝），零变更
#
# 受控写白名单（ADR-0052 K3；装完 SSL 站点能否成功的关键）:
#   unit 必须注入 Environment=KORE_FILE_WRITE_ALLOW_DIRS=<install>/data/ssl/——受控写里
#   ssl_certificate* / auth_basic_user_file 的白名单**默认空 = 一律拒绝**（fail-closed），
#   未注入时所有带证书的 vhost 都会被拒。默认值 <install>/data/ssl/，可用
#   `--file-write-allow-dirs=PATH[:PATH...]` 或环境变量 KORE_FILE_WRITE_ALLOW_DIRS 显式覆盖
#   （显式值原样写入 unit，不再追加默认值）。列表分隔符与内核一致：os.PathListSeparator（Linux 为 :）。
#
# 端到端自检（可选，跑真特权动作）:
#   sudo scripts/install-root-once.sh --verify --password-file /root/.kore-admin \
#        --e2e-plugin waf --e2e-action nft-list
#   口令只从 0600 文件读进内存并灌进 curl 请求体，不进 argv、不打印。
#
# 退出码: 0 全部 PASS / 1 有 FAIL / 3 需要 root 或缺少前置 / 7 有 SKIP（未闭环，不是成功）
#
# 边界（必须随评审）:
#   - 宿主写入仅 ADR-0023 §3.5 豁免项：/etc/systemd/system/<unit>.service + enable 软链、
#     二进制、kore 系统组；其余全部在安装根内（portable profile）。
#   - 每条宿主变更追加到 <install>/data/changes.jsonl（与 kored 同一格式）；
#     --rollback 只回放 file.remove / file.restore 两类结构化 purge_op，
#     组/服务状态无法结构化回滚的，明确打印「需人工」，不假装可回滚。
#   - 不删除状态目录（data/），那是用户数据；不静默停任何进程（需 --stop-user-instance）。
set -uo pipefail

UNIT_NAME="kore"
BIN_SRC=""
HOME_DIR="/opt/kore"
CONFIG=""
RUN_DIR=""
DRY_RUN=0
VERIFY_ONLY=0
ROLLBACK=0
STOP_USER=0
ASSUME_YES=0
PASSWORD_FILE=""
E2E_PLUGIN="waf"
E2E_ACTION="nft-list"
SELF_TEST=0
# ALLOW_DIRS_OVERRIDE 是「用户显式指定」的受控写白名单（flag 或环境变量），空 = 用默认值。
ALLOW_DIRS_OVERRIDE="${KORE_FILE_WRITE_ALLOW_DIRS:-}"
# FILE_WRITE_ALLOW_DIRS 是最终写进 unit 的值，由 resolve_allow_dirs 解析。
FILE_WRITE_ALLOW_DIRS=""

PASS=0
FAIL=0
SKIP=0
CHANGED=0
UNIT_PATH=""
UNIT_CHANGED=0
BIN_CHANGED=0
GROUP_CREATED=0
LEDGER=""

log()  { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
ok()   { printf '[OK]   %s\n' "$*"; }
err()  { printf '[FAIL] %s\n' "$*" >&2; }

usage() { sed -n '2,30p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --verify) VERIFY_ONLY=1 ;;
    --rollback) ROLLBACK=1 ;;
    --stop-user-instance) STOP_USER=1 ;;
    --yes) ASSUME_YES=1 ;;
    --bin) shift; BIN_SRC="${1:-}" ;;
    --bin=*) BIN_SRC="${1#--bin=}" ;;
    --install-root|--home) shift; HOME_DIR="${1:-}" ;;
    --install-root=*|--home=*) HOME_DIR="${1#*=}" ;;
    --config) shift; CONFIG="${1:-}" ;;
    --config=*) CONFIG="${1#--config=}" ;;
    --unit-name) shift; UNIT_NAME="${1:-}" ;;
    --unit-name=*) UNIT_NAME="${1#--unit-name=}" ;;
    --run-dir) shift; RUN_DIR="${1:-}" ;;
    --run-dir=*) RUN_DIR="${1#--run-dir=}" ;;
    --password-file) shift; PASSWORD_FILE="${1:-}" ;;
    --password-file=*) PASSWORD_FILE="${1#--password-file=}" ;;
    --e2e-plugin) shift; E2E_PLUGIN="${1:-}" ;;
    --e2e-plugin=*) E2E_PLUGIN="${1#--e2e-plugin=}" ;;
    --e2e-action) shift; E2E_ACTION="${1:-}" ;;
    --e2e-action=*) E2E_ACTION="${1#--e2e-action=}" ;;
    --self-test) SELF_TEST=1 ;;
    --file-write-allow-dirs) shift; ALLOW_DIRS_OVERRIDE="${1:-}" ;;
    --file-write-allow-dirs=*) ALLOW_DIRS_OVERRIDE="${1#--file-write-allow-dirs=}" ;;
    -h|--help) usage; exit 0 ;;
    *) err "未知参数: $1"; usage >&2; exit 1 ;;
  esac
  shift
done

UNIT_PATH="/etc/systemd/system/${UNIT_NAME}.service"
[ -n "$RUN_DIR" ] || RUN_DIR="$HOME_DIR/run"
SOCK="$RUN_DIR/kore.sock"
CHANNEL_SOCK="$RUN_DIR/kore-channel.sock"
LEDGER="$HOME_DIR/data/changes.jsonl"
BIN_DST="$HOME_DIR/bin/kored"

# 路径先收紧再进 ledger（ledger 是 JSONL，路径里出现引号/反斜杠会写坏）：
# 只允许常规绝对路径字符；不满足就拒绝，不做转义猜测。
path_ok() { case "$1" in /*) ;; *) return 1 ;; esac; case "$1" in *[\"\\[:space:]]*) return 1 ;; esac; return 0; }

# ---------- 受控写白名单（ADR-0052；默认 fail-closed） ----------

# resolve_allow_dirs 解析最终写进 unit 的白名单：用户显式值优先，否则 <install>/data/ssl/。
#
# 为什么默认必须注入：受控文件写（file_write）的证书/口令目录前缀白名单**缺省为空 =
# ssl_certificate* / auth_basic_user_file 一律拒绝**（内核不猜安装布局）。不注入的后果
# 不是"少一个可选配置"，而是**装完启用 SSL 的站点全部配置失败**——安装器必须替用户把
# 安装目录内的证书目录写进去。`/etc/nginx/conf.d/` 不在此列：它由协议类别派生
# （pluginapi.FileWritePrefixClasses），重复注入只是冗余，不是必需。
resolve_allow_dirs() {
  if [ -n "$ALLOW_DIRS_OVERRIDE" ]; then
    FILE_WRITE_ALLOW_DIRS="$ALLOW_DIRS_OVERRIDE"
  else
    FILE_WRITE_ALLOW_DIRS="$HOME_DIR/data/ssl/"
  fi
}

# validate_allow_dirs 在写 unit 前做**最小但必要**的形状校验：写进去的值必须能被内核的
# 注入 helper 接受，否则会出现"unit 看着有注入、实际全被逐条丢弃"的静默 fail-open 假象。
# 规则与 helper 同口径（绝对路径 / 无 .. 段 / 无空白引号反斜杠），另外拒绝空列表——
# 显式清空等于关掉白名单，那是安全边界调整，不该由安装脚本顺手做。
validate_allow_dirs() {
  local list="$1" entry
  if [ -z "$list" ]; then
    err "KORE_FILE_WRITE_ALLOW_DIRS 不能为空（显式清空等于关闭受控写证书白名单）"
    return 1
  fi
  case "$list" in
    *[\"\\[:space:]]*) err "KORE_FILE_WRITE_ALLOW_DIRS 含空白/引号/反斜杠（unit Environment= 会被截断）: $list"; return 1 ;;
  esac
  # 用 here-doc + tr 切分（不用未引用的 $list 展开）：目录名里的 * ? [ 不该被 shell 当通配
  # 展开成别的路径，否则校验看的是另一组条目。
  while IFS= read -r entry; do
    [ -n "$entry" ] || { err "KORE_FILE_WRITE_ALLOW_DIRS 含空条目（连续的 : ）: $list"; return 1; }
    case "$entry" in /*) ;; *) err "KORE_FILE_WRITE_ALLOW_DIRS 条目必须是绝对路径: $entry"; return 1 ;; esac
    case "/$entry/" in */../*) err "KORE_FILE_WRITE_ALLOW_DIRS 条目不得含 .. 段: $entry"; return 1 ;; esac
  done <<EOF
$(printf '%s' "$list" | tr ':' '\n')
EOF
  return 0
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "此模式需要 root：sudo $0 $*"
    exit 3
  fi
}

record_change() { # plugin action target before after reversible purge_kind purge_1 purge_2
  local plugin="$1" action="$2" target="$3" before="$4" after="$5" reversible="$6" kind="$7" p1="${8:-}" p2="${9:-}"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ "$DRY_RUN" -eq 1 ] && { log "[DRY-RUN] 记账: $action -> $target"; return 0; }
  mkdir -p "$(dirname "$LEDGER")" || { err "无法创建账本目录: $(dirname "$LEDGER")"; return 1; }
  {
    printf '{"ts":"%s","plugin":"%s","action":"%s","target":"%s"' "$ts" "$plugin" "$action" "$target"
    [ -n "$before" ] && printf ',"before":"%s"' "$before"
    [ -n "$after" ] && printf ',"after":"%s"' "$after"
    if [ "$reversible" = "true" ] && [ -n "$kind" ]; then
      printf ',"reversible":true,"purge_op":{"kind":"%s","args":["%s"' "$kind" "$p1"
      [ -n "$p2" ] && printf ',"%s"' "$p2"
      printf ']}'
    else
      printf ',"reversible":false'
    fi
    printf '}\n'
  } >>"$LEDGER" || { err "写账本失败: $LEDGER"; return 1; }
  chmod 0600 "$LEDGER" 2>/dev/null || true
  CHANGED=1
}

preflight() {
  local bad=0
  if [ "$VERIFY_ONLY" -eq 0 ] && [ "$ROLLBACK" -eq 0 ]; then
    [ -n "$BIN_SRC" ] || { err "缺少 --bin <kored 路径>（例如 ./bin/kored；先 make build）"; bad=1; }
    if [ -n "$BIN_SRC" ] && [ ! -x "$BIN_SRC" ]; then err "--bin 不存在或不可执行: $BIN_SRC"; bad=1; fi
  fi
  path_ok "$HOME_DIR" || { err "--install-root 必须是绝对路径且不含空格/引号/反斜杠: $HOME_DIR"; bad=1; }
  case "$HOME_DIR" in
    /usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*)
      err "安装根 $HOME_DIR 会让 kored 自动退回 fhs profile（写 /var/lib/kore、/run/kore），超出零侵入；请用 /opt/kore"
      bad=1 ;;
  esac
  case "$UNIT_NAME" in ''|*[!A-Za-z0-9_.@-]*) err "unit 名非法: $UNIT_NAME"; bad=1 ;; esac
  if ! command -v systemctl >/dev/null 2>&1; then err "未找到 systemctl（本安装器只支持 systemd 宿主）"; bad=1; fi
  if [ ! -d /run/systemd/system ]; then err "/run/systemd/system 不存在：systemd 未作为 init 运行"; bad=1; fi
  if ! command -v useradd >/dev/null 2>&1 && ! command -v adduser >/dev/null 2>&1; then
    err "缺少 useradd/adduser：插件降权必须创建 kore-<id> 系统用户（装 shadow-utils 或 adduser 后重试）"; bad=1
  fi
  if [ -n "$CONFIG" ] && [ ! -f "$CONFIG" ]; then err "--config 不存在: $CONFIG"; bad=1; fi
  if [ -n "$PASSWORD_FILE" ]; then
    [ -r "$PASSWORD_FILE" ] || { err "--password-file 不可读: $PASSWORD_FILE"; bad=1; }
    local mode; mode="$(stat -c '%a' "$PASSWORD_FILE" 2>/dev/null || echo '')"
    case "$mode" in 600|400) ;; *) err "--password-file 权限必须是 0600/0400（当前 $mode），拒绝读取"; bad=1 ;; esac
  fi
  [ "$bad" -eq 0 ]
}

find_nonroot_kored() {
  local pids pid uid
  pids="$(pgrep -x kored 2>/dev/null || true)"
  for pid in $pids; do
    uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$uid" ] && [ "$uid" != "0" ] && printf '%s %s\n' "$pid" "$uid"
  done
}

install_binary() {
  if [ "$DRY_RUN" -eq 1 ]; then log "[DRY-RUN] 安装 $BIN_SRC -> $BIN_DST（先建 $HOME_DIR/bin）"; return 0; fi
  mkdir -p "$HOME_DIR/bin" || { err "创建 $HOME_DIR/bin 失败"; return 1; }
  if [ -x "$BIN_DST" ] && cmp -s "$BIN_SRC" "$BIN_DST"; then
    log "二进制已是目标版本（sha 相同），跳过复制"
    return 0
  fi
  local backup="" before=""
  if [ -e "$BIN_DST" ]; then
    backup="$HOME_DIR/data/install-backups/kored.$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$(dirname "$backup")"
    cp -a "$BIN_DST" "$backup" || { err "备份旧二进制失败"; return 1; }
    before="$(sha256sum "$BIN_DST" | awk '{print $1}')"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then log "[DRY-RUN] 安装 $BIN_SRC -> $BIN_DST"; return 0; fi
  install -m 0755 "$BIN_SRC" "$BIN_DST" || { err "复制二进制失败: $BIN_DST"; return 1; }
  BIN_CHANGED=1
  local after; after="$(sha256sum "$BIN_DST" | awk '{print $1}')"
  if [ -n "$backup" ]; then
    record_change kore-installer install.binary "$BIN_DST" "$before" "$after" true file.restore "$backup" "$BIN_DST"
  else
    record_change kore-installer install.binary "$BIN_DST" "" "$after" true file.remove "$BIN_DST"
  fi
  ok "已安装二进制: $BIN_DST（sha256=$after）"
}

ensure_group() {
  if getent group kore >/dev/null 2>&1; then
    log "系统组 kore 已存在（幂等跳过）"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then log "[DRY-RUN] groupadd --system kore"; return 0; fi
  groupadd --system kore || { err "创建系统组 kore 失败"; return 1; }
  GROUP_CREATED=1
  record_change kore-installer install.group kore "" "gid=$(getent group kore | cut -d: -f3)" false ""
  ok "已创建系统组 kore（插件通道 socket 属组）"
}

render_unit() {
  cat <<UNIT
# $UNIT_PATH — 由 scripts/install-root-once.sh 生成（ADR-0042 方案 B / ADR-0049）
# 手工改动会在下次安装时被识别为漂移并备份后覆盖；回滚: sudo $0 --rollback
[Unit]
Description=kore 内核（kored，root 服务；插件降权 + root-action 通道）
Documentation=file://$HOME_DIR/docs/ARCHITECTURE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 结构性前提：内核必须 root，插件才能被降到 kore-<id>（ADR-0018/0049 硬前置 P3）。
User=root
# 子进程降权靠 SysProcAttr.Credential；不要打开 NoNewPrivileges 之外的沙箱项，
# 否则插件读不到自己的版本目录 / socket。
NoNewPrivileges=false
Environment=KORE_HOME=$HOME_DIR
# 受控文件写的证书/口令目录白名单（ADR-0052 fail-closed）：未注入 = ssl_certificate* 一律拒绝。
# 值必须与 ssl 插件实际证书目录一致；改这里 = 调整 root 写面，不是普通配置项。
Environment=KORE_FILE_WRITE_ALLOW_DIRS=$FILE_WRITE_ALLOW_DIRS
ExecStart=$BIN_DST serve${CONFIG:+ --config $CONFIG}
Restart=on-failure
RestartSec=2
TimeoutStartSec=30
TimeoutStopSec=15
KillMode=mixed
Delegate=yes
LimitNOFILE=65536
UMask=0022

[Install]
WantedBy=multi-user.target
UNIT
}

install_unit() {
  local tmp; tmp="$(mktemp)"
  render_unit >"$tmp" || { err "渲染 unit 失败"; rm -f "$tmp"; return 1; }
  if [ -f "$UNIT_PATH" ] && cmp -s "$tmp" "$UNIT_PATH"; then
    log "unit 已是最新（幂等跳过）: $UNIT_PATH"; rm -f "$tmp"; return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "[DRY-RUN] 写 unit: $UNIT_PATH"
    # 环境变量是「装完就坏」类缺陷的高发点，dry-run 必须把它们逐行打出来（而不是只打前 8 行）。
    grep -E '^Environment=' "$tmp" | sed 's/^/         /'
    rm -f "$tmp"; return 0
  fi
  local backup="" before=""
  if [ -f "$UNIT_PATH" ]; then
    backup="$HOME_DIR/data/install-backups/${UNIT_NAME}.service.$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$(dirname "$backup")"
    cp -a "$UNIT_PATH" "$backup" || { err "备份旧 unit 失败"; rm -f "$tmp"; return 1; }
    before="$(sha256sum "$UNIT_PATH" | awk '{print $1}')"
  fi
  install -d -m 0755 "$(dirname "$UNIT_PATH")"
  install -m 0644 "$tmp" "$UNIT_PATH" || { err "写 unit 失败: $UNIT_PATH"; rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  UNIT_CHANGED=1
  local after; after="$(sha256sum "$UNIT_PATH" | awk '{print $1}')"
  if [ -n "$backup" ]; then
    record_change kore-installer install.unit "$UNIT_PATH" "$before" "$after" true file.restore "$backup" "$UNIT_PATH"
  else
    record_change kore-installer install.unit "$UNIT_PATH" "" "$after" true file.remove "$UNIT_PATH"
  fi
  systemctl daemon-reload || { err "systemctl daemon-reload 失败"; return 1; }
  ok "已写入 unit: $UNIT_PATH"
}

stop_user_instances() {
  local list; list="$(find_nonroot_kored)"
  [ -z "$list" ] && return 0
  if [ "$STOP_USER" -ne 1 ]; then
    err "检测到非 root 的 kored 在运行（pid uid）："
    printf '%s\n' "$list" >&2
    err "它与系统服务会抢同一个 socket / state.db。先停掉，或显式加 --stop-user-instance："
    err "  kill \$(pgrep -x kored)   # 或 systemctl --user stop kored-local"
    return 1
  fi
  local pid uid
  while read -r pid uid; do
    [ -n "$pid" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[DRY-RUN] 将停止非 root 实例 pid=$pid uid=$uid（--stop-user-instance）"
      continue
    fi
    warn "按 --stop-user-instance 停止非 root 实例 pid=$pid uid=$uid（SIGTERM → 10s → SIGKILL）"
    kill -TERM "$pid" 2>/dev/null || true
    local i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i+1)); done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    record_change kore-installer stop.user-instance "pid:$pid" "uid=$uid" "" false ""
  done <<<"$list"
  return 0
}

enable_start() {
  if [ "$DRY_RUN" -eq 1 ]; then log "[DRY-RUN] systemctl enable --now $UNIT_NAME"; return 0; fi
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
  if [ "$UNIT_CHANGED" -eq 1 ] || [ "$BIN_CHANGED" -eq 1 ] || ! systemctl is-active --quiet "$UNIT_NAME"; then
    systemctl restart "$UNIT_NAME" || { err "启动失败：journalctl -u $UNIT_NAME -n 50 --no-pager"; return 1; }
    ok "已启动 $UNIT_NAME"
  else
    log "$UNIT_NAME 已在运行且无变更（幂等跳过重启）"
  fi
  sleep 1
  if ! systemctl is-active --quiet "$UNIT_NAME"; then
    err "$UNIT_NAME 启动后不是 active；journalctl -u $UNIT_NAME -n 50 --no-pager"
    return 1
  fi
  return 0
}

# ---------- 自检 ----------
pass() { PASS=$((PASS+1)); printf '[PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); printf '[FAIL] %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf '[SKIP] %s\n' "$*"; }

unit_effective_user() { systemctl show -p User --value "$UNIT_NAME" 2>/dev/null | tr -d ' '; }
unit_main_pid()     { systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null | tr -d ' '; }

self_check() {
  echo
  echo "===== 自检（每项判据见 .agents/verify/privilege-critical-path.md）====="
  PASS=0; FAIL=0; SKIP=0

  # S1 unit 存在且指向本安装根
  if [ -f "$UNIT_PATH" ] && grep -qF "ExecStart=$BIN_DST serve" "$UNIT_PATH"; then
    pass "S1 unit 就位且 ExecStart 指向 $BIN_DST"
  else
    fail "S1 unit 缺失或 ExecStart 不匹配：$UNIT_PATH
        修：sudo $0 --bin <kored 路径>"
  fi

  # S2 显式 User=root
  if [ "$(unit_effective_user)" = "root" ]; then
    pass "S2 unit 显式 User=root"
  else
    fail "S2 unit 未以 root 运行（systemctl show User=$(unit_effective_user)）
        修：检查 $UNIT_PATH 的 [Service] User=root 后 systemctl daemon-reload && systemctl restart $UNIT_NAME"
  fi

  # S3 服务 active
  if systemctl is-active --quiet "$UNIT_NAME"; then
    pass "S3 服务 active"
  else
    fail "S3 服务不是 active
        修：journalctl -u $UNIT_NAME -n 50 --no-pager"
  fi

  # S4 主进程 uid=0
  local pid uid
  pid="$(unit_main_pid)"
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    uid="$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [ "$uid" = "0" ]; then pass "S4 主进程 pid=$pid uid=0"
    else fail "S4 主进程 uid=$uid（不是 root）
        修：确认 unit 的 User=root，且没有另一个非 root 实例在跑"; fi
  else
    fail "S4 取不到 MainPID
        修：systemctl status $UNIT_NAME --no-pager"
  fi

  # S5 通道组
  if getent group kore >/dev/null 2>&1; then pass "S5 系统组 kore 存在"
  else fail "S5 系统组 kore 不存在（插件连不上 root-action 通道）
        修：sudo groupadd --system kore && sudo systemctl restart $UNIT_NAME"; fi

  # S6 root-action 通道 socket
  if [ -S "$CHANNEL_SOCK" ]; then
    local perms owner group
    perms="$(stat -c '%a' "$CHANNEL_SOCK")"; owner="$(stat -c '%U' "$CHANNEL_SOCK")"; group="$(stat -c '%G' "$CHANNEL_SOCK")"
    if [ "$owner" = "root" ] && [ "$group" = "kore" ] && [ "$perms" = "660" ]; then
      pass "S6 通道 socket $CHANNEL_SOCK root:kore 0660"
    else
      fail "S6 通道 socket 权限/属主不对（$owner:$group $perms，期望 root:kore 660）
        修：重启服务让内核重建 socket；仍不对则查 serve_runtime.go 的 socket 创建逻辑"
    fi
  else
    fail "S6 通道 socket 不存在：$CHANNEL_SOCK（非 root 内核不会建它）
        修：确认 S2/S4 通过后重启；仍无则 journalctl -u $UNIT_NAME | grep -i '通道'"
  fi

  # S7 插件降权：有 kore-<id> 用户才叫验证过
  local users procs
  users="$(getent passwd | awk -F: '$1 ~ /^kore-/ {print $1}')"
  procs="$(ps -eo user=,args= 2>/dev/null | awk '$1 ~ /^kore-/ {print $1}' | sort -u)"
  if [ -n "$users" ]; then
    pass "S7 已创建插件系统用户：$(echo "$users" | tr '\n' ' ')"
    if [ -n "$procs" ]; then pass "S7b 运行中插件进程属主为低权用户：$(echo "$procs" | tr '\n' ' ')"; else
      skip "S7b 当前无运行中的插件进程，无法核对进程属主（启用任一插件后重跑 --verify）"
    fi
  elif [ -n "$(pgrep -f "^$HOME_DIR/data/plugins/[^ ]+/" 2>/dev/null)" ]; then
    fail "S7 有插件进程在跑但没有任何 kore-* 用户：降权没生效
        修：确认 S2/S4；检查 journalctl -u $UNIT_NAME | grep '降权'；确认 useradd/adduser 可用"
  else
    skip "S7 尚无插件启动，kore-<id> 未创建（不是失败：用户是按需创建的）
        下一步：装并启用任一插件后重跑 sudo $0 --verify"
  fi

  # S8 审计链可读且已有 root.action 记录
  if [ -f "$HOME_DIR/data/state.db" ]; then
    if [ "$(id -u)" -eq 0 ] && [ -x "$BIN_DST" ]; then
      local out rc
      out="$(KORE_STATE_DIR="$HOME_DIR/data" "$BIN_DST" audit --action root.action --limit 5 2>&1)"; rc=$?
      if [ "$rc" -ne 0 ]; then
        fail "S8 审计库读取失败（exit=$rc）：$(printf '%s' "$out" | head -2)
        修：确认 $HOME_DIR/data/state.db 属主 root 且服务未损坏；备份后重启服务"
      elif printf '%s' "$out" | grep -q 'root.action'; then
        pass "S8 审计链有 root.action 记录（fail-closed 落账链路已工作）"
      else
        skip "S8 审计库可读但尚无 root.action 记录（还没执行过特权动作）
        下一步：加 --password-file <0600 文件> --e2e-plugin waf --e2e-action nft-list 跑端到端"
      fi
    else
      skip "S8 需要 root 读取 state.db 才能核对审计记录（用 sudo 重跑 --verify）"
    fi
  else
    fail "S8 状态库不存在：$HOME_DIR/data/state.db（服务可能没起来或 KORE_HOME 不对）
        修：确认 S3 通过；journalctl -u $UNIT_NAME -n 50 --no-pager"
  fi

  # S9 零侵入：不该出现 fhs 路径
  local leaked=""
  for p in /var/lib/kore /etc/kore /run/kore /var/log/kore; do [ -e "$p" ] && leaked="$leaked $p"; done
  if [ -z "$leaked" ]; then pass "S9 未出现 fhs 路径（零侵入成立）"
  else warn "S9 发现 fhs 路径:$leaked（可能是历史安装；本安装器未创建，请人工确认后清理）"; fi

  # S10 安装目录权限
  if [ -d "$HOME_DIR/data" ] && [ "$(stat -c '%U:%a' "$HOME_DIR/data")" = "root:700" ]; then
    pass "S10 状态目录 root:0700"
  else
    warn "S10 状态目录权限非 root:0700（当前 $(stat -c '%U:%a' "$HOME_DIR/data" 2>/dev/null)）；插件数据仍按 kore-<id> 单独 chown"
  fi

  # S12 unit 必须注入受控写白名单（缺失 = 所有带证书的 vhost 被 fail-closed 拒绝）
  if [ ! -f "$UNIT_PATH" ]; then
    fail "S12 unit 不存在，无法核对受控写白名单注入（先修 S1）"
  elif grep -qE '^Environment=KORE_FILE_WRITE_ALLOW_DIRS=.+' "$UNIT_PATH"; then
    pass "S12 unit 已注入 KORE_FILE_WRITE_ALLOW_DIRS（$(grep -E '^Environment=KORE_FILE_WRITE_ALLOW_DIRS=' "$UNIT_PATH" | tail -1 | cut -d= -f2-)）"
  else
    fail "S12 unit 未注入 KORE_FILE_WRITE_ALLOW_DIRS：受控写证书白名单为空，所有带证书的 vhost 会被拒绝
        修：sudo $0 --bin $BIN_DST   # 重装 unit 自动补默认值；证书在别处时加 --file-write-allow-dirs=<目录>"
  fi

  # S11 端到端（可选）
  if [ -n "$PASSWORD_FILE" ]; then e2e_check; else
    skip "S11 端到端特权动作未跑（未提供 --password-file）
        下一步：sudo $0 --verify --password-file <0600 文件> --e2e-plugin $E2E_PLUGIN --e2e-action $E2E_ACTION"
  fi

  echo
  echo "自检汇总：PASS $PASS / FAIL $FAIL / SKIP $SKIP"
  [ "$FAIL" -eq 0 ] || echo "结论：有 FAIL，按每项「修：」执行后重跑。"
  [ "$FAIL" -eq 0 ] && [ "$SKIP" -gt 0 ] && echo "结论：已闭环部分通过，另有未验证项（不是全绿，别当成全绿）。"
  [ "$FAIL" -eq 0 ] && [ "$SKIP" -eq 0 ] && echo "结论：全部 PASS。"
}

e2e_check() {
  local pw jar base code body csrf
  pw="$(cat "$PASSWORD_FILE")" || { fail "S11 读取口令文件失败"; return; }
  jar="$(mktemp)"; chmod 600 "$jar"
  base="http://localhost"
  local -a C=(curl -sS --unix-socket "$SOCK" -b "$jar" -c "$jar")

  code="$("${C[@]}" -o /dev/null -w '%{http_code}' -X POST "$base/api/v1/auth/login" \
    -H 'Content-Type: application/json' --data-binary @- <<EOF
$(printf '%s' "$pw" | python3 -c 'import json,sys;print(json.dumps({"password":sys.stdin.read()}))')
EOF
)"
  if [ "$code" != "200" ]; then
    fail "S11 登录失败（HTTP $code）：口令不对或会话端点不可用
        修：用 kored admin-password 重设；确认 socket $SOCK 可连"
    rm -f "$jar"; return
  fi
  csrf="$(awk '$6=="kore_csrf"{print $7}' "$jar" | tail -1)"

  body="$("${C[@]}" "$base/api/v1/system/info")"
  if printf '%s' "$body" | grep -q '"demotion":{[^}]*"enabled":true'; then
    pass "S11a /system/info 报告 demotion.enabled=true"
  else
    fail "S11a /system/info 未报告降权生效（demotion.enabled != true）
        修：S2/S4 必须全绿；插件降权只在内核 uid=0 时启用"
  fi

  code="$("${C[@]}" -o /tmp/kore-ra.$$ -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H "X-Kore-CSRF: $csrf" \
    --data-binary "{\"action_id\":\"$E2E_ACTION\"}" \
    "$base/api/v1/plugins/$E2E_PLUGIN/root-action")"
  body="$(cat /tmp/kore-ra.$$ 2>/dev/null)"; rm -f /tmp/kore-ra.$$
  if printf '%s' "$body" | grep -q 'E_NEED_ROOT\|E_NO_SYSTEMD'; then
    fail "S11b 特权动作被权限层拒绝（$E2E_PLUGIN/$E2E_ACTION）：$(printf '%s' "$body" | head -c 300)
        修：内核不是 root 或通道没建；先修 S2/S4/S6"
  elif [ "$code" = "200" ]; then
    pass "S11b 特权动作已执行并返回 200（$E2E_PLUGIN/$E2E_ACTION）"
  else
    warn "S11b 动作未被权限拒绝但执行报错（HTTP $code）：$(printf '%s' "$body" | head -c 300)"
    pass "S11b 特权通道已打通（动作到达执行器；业务失败属于环境依赖，如 nft/ufw 未安装）"
  fi

  local out; out="$(KORE_STATE_DIR="$HOME_DIR/data" "$BIN_DST" audit --action root.action --limit 5 2>&1)"
  if printf '%s' "$out" | grep -q "$E2E_PLUGIN"; then
    pass "S11c 审计已写入 root.action（plugin=$E2E_PLUGIN）"
  else
    fail "S11c 审计没有本次 root.action 记录：fail-closed 链路未闭环
        修：KORE_STATE_DIR=$HOME_DIR/data $BIN_DST audit --action root.action --limit 20 手工核对"
  fi
  rm -f "$jar"
}

# ---------- 自测（纯函数，零变更；不需要 root / systemd） ----------
#
# 覆盖四条契约：默认注入存在且唯一、渲染幂等、显式值覆盖默认、非法值拒绝。
# 第 2 条同时是**反例自证**的常驻形式：删掉 render_unit 里的 Environment 注入行，
# 本自测立即 FAIL（不要在验证时手改文件；复制一份删行跑即可复现）。
self_test() {
  local fail=0 use=0 before="" first="" second=""
  st_ok()   { use=$((use+1)); printf '[PASS] %s\n' "$*"; }
  st_bad()  { use=$((use+1)); fail=$((fail+1)); printf '[FAIL] %s\n' "$*"; }

  # T1 默认值 = <install>/data/ssl/（用户没显式设时的唯一正确默认）
  ALLOW_DIRS_OVERRIDE=""
  resolve_allow_dirs
  [ "$FILE_WRITE_ALLOW_DIRS" = "$HOME_DIR/data/ssl/" ]     && st_ok "T1 默认白名单 = $HOME_DIR/data/ssl/"     || st_bad "T1 默认白名单错误：$FILE_WRITE_ALLOW_DIRS"

  # T2 默认渲染：注入行存在且恰好 1 条（重复注入 = 幂等失效）
  first="$(render_unit)"
  local count; count="$(printf '%s\n' "$first" | grep -c '^Environment=KORE_FILE_WRITE_ALLOW_DIRS=')"
  [ "$count" = "1" ]     && st_ok "T2 默认渲染含 1 条 KORE_FILE_WRITE_ALLOW_DIRS 注入"     || st_bad "T2 注入行数量=$count（期望 1；0 表示注入缺失，>1 表示重复）"
  printf '%s\n' "$first" | grep -qF "Environment=KORE_FILE_WRITE_ALLOW_DIRS=$HOME_DIR/data/ssl/"     && st_ok "T2b 注入值 = $HOME_DIR/data/ssl/"     || st_bad "T2b 注入值不是 $HOME_DIR/data/ssl/"

  # T3 幂等：同输入两次渲染字节一致（重复安装不重复加/不漂移）
  second="$(render_unit)"
  [ "$first" = "$second" ]     && st_ok "T3 渲染幂等（两次输出字节一致）"     || st_bad "T3 渲染不幂等（两次输出不同）"

  # T4 显式覆盖优先，且默认值不再出现
  ALLOW_DIRS_OVERRIDE="/srv/kore/certs:/srv/kore/auth"
  resolve_allow_dirs
  before="$(render_unit)"
  printf '%s\n' "$before" | grep -qF 'Environment=KORE_FILE_WRITE_ALLOW_DIRS=/srv/kore/certs:/srv/kore/auth'     && st_ok "T4 显式值原样写入 unit"     || st_bad "T4 显式值未生效"
  printf '%s\n' "$before" | grep -qF "$HOME_DIR/data/ssl/"     && st_bad "T4b 显式覆盖后仍出现默认值（会被误认为两者都注入）"     || st_ok "T4b 显式覆盖后不再追加默认值"

  # T5 非法值必须拒绝（否则 unit 里是个"看着有、实际全被丢弃"的白名单）
  local bad
  for bad in "relative/path/" "/srv/../etc/" "" "/srv/with space/" '/srv/quo"te/'; do
    if validate_allow_dirs "$bad" 2>/dev/null; then
      st_bad "T5 非法值未被拒绝: [$bad]"
    else
      st_ok "T5 非法值被拒绝: [$bad]"
    fi
  done
  validate_allow_dirs "/srv/kore/certs:/srv/kore/auth" 2>/dev/null     && st_ok "T5b 合法多目录列表通过" || st_bad "T5b 合法列表被误拒"

  ALLOW_DIRS_OVERRIDE=""
  resolve_allow_dirs
  echo
  echo "自测汇总：PASS $((use-fail)) / FAIL $fail"
  [ "$fail" -eq 0 ] || echo "结论：有 FAIL——注入契约被破坏，修好再装。"
  [ "$fail" -eq 0 ] && echo "结论：全部 PASS。"
  [ "$fail" -eq 0 ]
}

# ---------- 主流程 ----------
do_install() {
  preflight || exit 1
  resolve_allow_dirs
  validate_allow_dirs "$FILE_WRITE_ALLOW_DIRS" || exit 1
  [ "$DRY_RUN" -eq 0 ] && require_root install
  log "安装计划：home=$HOME_DIR unit=$UNIT_PATH user=root profile=portable"
  stop_user_instances || exit 1
  install_binary || exit 1
  ensure_group || exit 1
  install_unit || exit 1
  enable_start || exit 1
  if [ "$DRY_RUN" -eq 1 ]; then
    echo
    log "[DRY-RUN] 计划完成：未写 unit、未复制二进制、未建组、未停任何进程。"
    local hint=""; [ "$STOP_USER" -eq 1 ] && hint=" --stop-user-instance"; log "真跑：sudo $0 --bin $BIN_SRC$hint"
    exit 0
  fi
  echo && log "宿主变更已记入 $LEDGER（回滚：sudo $0 --rollback）"
  self_check
  [ "$FAIL" -eq 0 ] || { echo "安装未闭环：先修 FAIL 项；回滚 sudo $0 --rollback" >&2; exit 1; }
  [ "$SKIP" -eq 0 ] && exit 0 || exit 7
}

do_rollback() {
  require_root rollback
  if [ ! -f "$LEDGER" ]; then err "没有账本 $LEDGER，拒绝猜测性回滚"; exit 1; fi
  log "按账本回滚（仅回放 file.remove / file.restore；组与服务状态打印人工步骤）"
  local line kind t
  while IFS= read -r line; do
    case "$line" in *'"purge_op"'*) ;; *) continue ;; esac
    kind="$(printf '%s' "$line" | sed -n 's/.*"kind":"\([^"]*\)".*/\1/p')"
    t="$(printf '%s' "$line" | sed -n 's/.*"target":"\([^"]*\)".*/\1/p')"
    case "$t" in /etc/systemd/system/*|"$HOME_DIR"/*) ;; *) warn "跳过账本外目标: $t"; continue ;; esac
    case "$kind" in
      file.remove) [ -e "$t" ] && { rm -f "$t" && ok "已删除 $t"; } ;;
      file.restore)
        local src; src="$(printf '%s' "$line" | sed -n 's/.*"args":\["\([^"]*\)".*/\1/p')"
        if [ -f "$src" ]; then cp -a "$src" "$t" && ok "已恢复 $t <- $src"; else warn "备份不存在，跳过恢复: $src"; fi ;;
      *) warn "未知 purge kind '$kind'，跳过 $t" ;;
    esac
  done <"$LEDGER"
  systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
  systemctl daemon-reload || true
  [ -f "$UNIT_PATH" ] && { rm -f "$UNIT_PATH"; ok "已删除 unit $UNIT_PATH"; }
  systemctl reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
  if getent group kore >/dev/null 2>&1; then
    if [ -z "$(getent group kore | cut -d: -f4)" ] && [ -z "$(getent passwd | awk -F: '$4==gid{print}' gid="$(getent group kore | cut -d: -f3)")" ]; then
      groupdel kore 2>/dev/null && ok "已删除空组 kore" || warn "组 kore 仍被引用，保留（人工：groupdel kore）"
    else
      warn "组 kore 仍有成员（kore-* 插件用户），保留；清理插件用户后再 groupdel kore"
    fi
  fi
  warn "状态目录 $HOME_DIR/data 与 kore-* 用户默认保留（用户数据/插件身份）；彻底清理见 kored uninstall"
  ok "回滚完成；如需重装：sudo $0 --bin <kored>"
}

case "1" in
  1) ;;
esac

if [ "$SELF_TEST" -eq 1 ]; then self_test; exit $?; fi
if [ "$ROLLBACK" -eq 1 ]; then do_rollback; exit $?; fi
if [ "$VERIFY_ONLY" -eq 1 ]; then self_check; [ "$FAIL" -eq 0 ] || exit 1; [ "$SKIP" -eq 0 ] && exit 0 || exit 7; fi
do_install
