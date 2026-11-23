#!/usr/bin/env bash
# 安装**系统级 root** 的 kore 服务（ADR-0042 方案 B：结构性消除授权判定）。
#
# 用法:
#   scripts/install-system-service.sh --dry-run              # 打印 unit 与计划，零变更
#   scripts/install-system-service.sh --install-root /opt/kore
#   scripts/install-system-service.sh --remove               # 停服务 + 删 unit（幂等）
#
# 关键参数（都可省略，默认值见下）:
#   --bin PATH             kored 路径（默认 <install-root>/bin/kored，其次 PATH 里的 kored）
#   --install-root DIR     KORE_HOME（默认 /opt/kore；从 --bin 推导）
#   --config PATH          显式 --config（默认 <install-root>/config/config.yaml，存在才写进 ExecStart）
#   --name NAME            unit 名（默认 kore）
#   --force                跳过"用户级实例仍在运行"的阻断（不会替你停它，需另按提示操作）
#
# 退出码: 0 成功/已最新 / 1 参数或环境错误 / 3 需要 root / 4 检测到用户级实例在跑
#
# ── 为什么是 root，以及为什么不涉及 polkit ────────────────────────────────
# 方案 B：kore.service 装在 /etc/systemd/system/、以 User=root 运行。
# 特权动作（防火墙 / sshd 加固 / 容器）由 **已经以 root 运行的内核** 经
# systemd-run 拉起 transient unit；systemd 对 uid=0 直接放行，**不查询 polkit**，
# 因此运行期不存在"授权判定"这一步，更不存在口令输入。对比方案 A（kored 普通
# 用户 + polkit 免密规则）：A 每次操作仍过一次 authorization check，只是不弹框，
# 语义上仍保留"授权"这一层，且规则本身是一个静默提权面。ADR-0042 选 B。
#
# 安全边界（必须随脚本评审）：
#   1. 内核进程面变大（root 进程），这是 B 的主要代价；插件仍必须是独立低权进程
#      （supervisor 把插件降到 kore-<id>，G-04 / ADR-0018 不变），插件永不获得 root。
#   2. 只写 ADR-0023 §3.5 豁免 #1 的 /etc/systemd/system/<name>.service + enable 软链，
#      **不写** /run/kore、/var/lib/kore、/etc/kore：状态 / socket / 日志全部留在安装根内，
#      因此本方案不新增任何零侵入豁免项（方案 A 的规则文件则必须新增豁免）。
#   3. 安装是一次性的运维动作；卸载 = 停服务 + 删 unit + daemon-reload（本脚本 --remove）。
#   4. root 内核不会自动把已存在的用户级实例"抢"过来；检测到 kored-local 在跑即阻断，
#      由运维显式 stop/disable 后再装，避免两个实例抢同一个 state/ socket。
set -euo pipefail

UNIT_NAME="kore"
BIN=""
INSTALL_ROOT=""
CONFIG=""
FORCE=0
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --remove)  MODE="remove" ;;
    --force)   FORCE=1 ;;
    --bin)     shift; BIN="${1:-}" ;;
    --bin=*)   BIN="${1#--bin=}" ;;
    --install-root) shift; INSTALL_ROOT="${1:-}" ;;
    --install-root=*) INSTALL_ROOT="${1#--install-root=}" ;;
    --config)  shift; CONFIG="${1:-}" ;;
    --config=*) CONFIG="${1#--config=}" ;;
    --name)    shift; UNIT_NAME="${1:-}" ;;
    --name=*)  UNIT_NAME="${1#--name=}" ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "[FAIL] 未知参数: $1" >&2; exit 1 ;;
  esac
  shift
done

UNIT_PATH="/etc/systemd/system/$UNIT_NAME.service"
UNIT_DIR="$(dirname "$UNIT_PATH")"

resolve_paths() {
  if [ -z "$BIN" ]; then
    if [ -n "$INSTALL_ROOT" ] && [ -x "$INSTALL_ROOT/bin/kored" ]; then
      BIN="$INSTALL_ROOT/bin/kored"
    elif [ -n "$INSTALL_ROOT" ]; then
      BIN="$INSTALL_ROOT/bin/kored"
    elif command -v kored >/dev/null 2>&1; then
      BIN="$(command -v kored)"
    else
      BIN="/opt/kore/bin/kored"
    fi
  fi
  if [ -z "$INSTALL_ROOT" ]; then
    INSTALL_ROOT="$(cd "$(dirname "$BIN")/.." 2>/dev/null && pwd || echo /opt/kore)"
  fi
  if [ -z "$CONFIG" ]; then
    if [ -f "$INSTALL_ROOT/config/config.yaml" ]; then
      CONFIG="$INSTALL_ROOT/config/config.yaml"
    fi
  fi
}

render_unit() {
  cat <<UNIT
# $UNIT_PATH — 由 scripts/install-system-service.sh 生成（ADR-0042 方案 B）
# 手工改动会在下次安装时被覆盖；卸载: sudo scripts/install-system-service.sh --remove
[Unit]
Description=kore 内核（kored，root 服务；特权动作零交互）
Documentation=file://$INSTALL_ROOT/docs/ARCHITECTURE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 方案 B 的核心一行：内核以 root 运行，特权动作由内核代理由 systemd 直接执行。
# uid=0 不查 polkit → 运行期没有"授权判定"，也没有口令输入。
User=root
# 内核需要 root；插件仍由 supervisor 降到 kore-<id>（G-04 / ADR-0018 不变）。
NoNewPrivileges=false
Environment=KORE_HOME=$INSTALL_ROOT
ExecStart=$BIN serve${CONFIG:+ --config $CONFIG}
Restart=on-failure
RestartSec=2
TimeoutStopSec=15
TimeoutStartSec=30
KillMode=mixed
Delegate=yes
LimitNOFILE=65536
UMask=0022

[Install]
WantedBy=multi-user.target
UNIT
}

resolve_paths
if [ ! -x "$BIN" ]; then
  echo "[FAIL] kored 不可执行: $BIN（先 make build 或用 --bin 指定）" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "[FAIL] 未找到 systemctl：非 systemd 环境请前台运行 $BIN serve" >&2
  exit 1
fi

# 用户级实例检测（两个实例会抢同一 state/socket 目录）。
user_unit_active() {
  systemctl --user is-active --quiet kored-local 2>/dev/null
}

case "$MODE" in
  dry-run|install)
    echo "kore 系统级 root 服务安装计划（ADR-0042 方案 B）"
    echo "  unit 文件 : $UNIT_PATH（ADR-0023 §3.5 豁免 #1）"
    echo "  ExecStart : $BIN serve${CONFIG:+ --config $CONFIG}"
    echo "  KORE_HOME : $INSTALL_ROOT"
    echo "  运行身份  : root（uid=0；特权动作不经 polkit 授权）"
    echo "  状态/日志 : 全部在 $INSTALL_ROOT 内（不新增零侵入豁免）"
    if user_unit_active; then
      echo "  [WARN] 检测到 systemctl --user 的 kored-local 正在运行（同一 state/socket 会冲突）"
    else
      echo "  [OK] 未检测到用户级 kored-local 实例"
    fi
    echo
    echo "----- unit 内容（$UNIT_PATH）-----"
    render_unit
    echo "----- unit 内容结束 -----"
    if [ -e "$UNIT_PATH" ] && diff -q <(render_unit) "$UNIT_PATH" >/dev/null 2>&1; then
      echo "[OK] 已安装且内容一致（幂等，无需改动）"
    fi
    ;;
  remove)
    echo "kore 系统级服务卸载计划"
    echo "  unit 文件 : $UNIT_PATH"
    ;;
esac

if [ "$MODE" = "install" ] && [ "$(id -u)" -ne 0 ]; then
  echo
  echo "[NEED-ROOT] 安装系统服务需要 root。以运维身份执行（脚本不自行提权）："
  echo "  sudo bash $(printf '%q' "$0") --install-root $(printf '%q' "$INSTALL_ROOT")"
  echo "  非 root 只读预演：bash $(printf '%q' "$0") --dry-run --install-root $(printf '%q' "$INSTALL_ROOT")"
  exit 3
fi

if [ "$MODE" = "remove" ] && [ "$(id -u)" -ne 0 ]; then
  echo "[NEED-ROOT] 卸载需要 root：sudo bash $0 --remove" >&2
  exit 3
fi

if [ "$MODE" = "remove" ]; then
  if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    systemctl stop "$UNIT_NAME" || true
    echo "[OK] 已停止 $UNIT_NAME"
  fi
  if [ -e "$UNIT_PATH" ]; then
    rm -f "$UNIT_PATH"
    systemctl daemon-reload
    echo "[OK] 已删除 $UNIT_PATH 并 daemon-reload（幂等）"
  else
    echo "[OK] unit 不存在，无需卸载（幂等）"
  fi
  exit 0
fi

if [ "$MODE" = "dry-run" ]; then
  echo "[DRY-RUN] 未写入任何文件（真实安装请 sudo 执行同一命令，去掉 --dry-run）"
  exit 0
fi

# ---- 真装（root）----
if user_unit_active && [ "$FORCE" -eq 0 ]; then
  echo
  echo "[BLOCKED] 用户级 kored-local 仍在运行；两个实例会抢同一 state/socket。" >&2
  echo "  先由该用户停掉并禁用（在图形会话里，或用 runuser）：" >&2
  echo "    systemctl --user disable --now kored-local" >&2
  echo "  然后重跑本脚本；确认知情可加 --force（脚本不会替你停）。" >&2
  exit 4
fi

mkdir -p "$UNIT_DIR"
tmp="$(mktemp "$UNIT_DIR/.$UNIT_NAME.service.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
render_unit >"$tmp"
chmod 0644 "$tmp"
chown root:root "$tmp"
if [ -e "$UNIT_PATH" ] && cmp -s "$tmp" "$UNIT_PATH"; then
  echo "[OK] unit 已是最新（幂等）: $UNIT_PATH"
else
  mv -f "$tmp" "$UNIT_PATH"
  echo "[OK] 已写入 $UNIT_PATH"
fi
systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"
sleep 1
echo "[OK] $UNIT_NAME: $(systemctl is-active "$UNIT_NAME" 2>/dev/null || echo unknown)（root 运行：$(systemctl show -p User --value "$UNIT_NAME" 2>/dev/null)）"
echo "  验证特权动作（应零交互、无 polkit）："
echo "    curl -sS --unix-socket $(printf '%q' "$INSTALL_ROOT")/run/kore.sock -b <cookie> \\"
echo "      -X POST http://kore/api/v1/plugins/firewall/root-action -d '{\"action_id\":\"ufw-status\"}'"
echo "  撤销：sudo bash $0 --remove"
