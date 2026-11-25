#!/usr/bin/env bash
# 安装 systemd unit（ADR-0023 §3.5 豁免 #1；唯一被豁免的常规侵入）。
#
# 用法: scripts/install-service.sh <kored 绝对路径> <安装根> <unit 目录> <unit 名> [白名单]
#       scripts/install-service.sh --dry-run <kored 绝对路径> <安装根> [unit 目录] [unit 名]
#
# 受控写白名单（ADR-0052 K3；装完 SSL 站点能否成功的关键）:
#   unit 必须注入 Environment=KORE_FILE_WRITE_ALLOW_DIRS=<安装根>/data/ssl/——受控写里
#   ssl_certificate* / auth_basic_user_file 的目录前缀白名单**默认空 = 一律拒绝**
#   （fail-closed），不注入时所有带证书的 vhost 都会被拒。默认值 <安装根>/data/ssl/；
#   可用第 5 个位置参数或环境变量 KORE_FILE_WRITE_ALLOW_DIRS 显式覆盖（位置参数优先，
#   显式值原样写入 unit、不再追加默认值）。列表分隔符与内核一致（Linux 为 :）。
#   非法值（相对路径 / .. 段 / 空白引号反斜杠 / 空条目 / 空列表）直接拒绝，exit 1。
#
# --dry-run: 打印计划与将要写入的 unit，零变更、不需要 root（真装去掉该 flag 并用 root）。
# 退出码: 0 成功 / 1 参数、白名单非法或权限 / 2 写 unit 失败
set -euo pipefail

DRY_RUN=0
POS=()

usage() { awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "[FAIL] 未知参数: $1" >&2; usage >&2; exit 1 ;;
    *) POS+=("$1") ;;
  esac
  shift
done

BIN="${POS[0]:-}"
INSTALL_ROOT="${POS[1]:-}"
UNIT_DIR="${POS[2]:-/etc/systemd/system}"
UNIT_NAME="${POS[3]:-kore.service}"
# 白名单：位置参数（显式）> 环境变量 > 默认 <安装根>/data/ssl/。
ALLOW_DIRS_OVERRIDE="${POS[4]:-${KORE_FILE_WRITE_ALLOW_DIRS:-}}"
FILE_WRITE_ALLOW_DIRS=""

if [ -z "$BIN" ] || [ -z "$INSTALL_ROOT" ]; then
  echo "[FAIL] 缺参数：$(usage)" >&2
  exit 1
fi

# 受控写白名单的解析/校验是**单一真源** scripts/lib/allow-dirs.sh：本脚本与
# install-root-once.sh / install.sh 共用同一份实现，改库 = 三个同时生效。
# 不要在本脚本重新定义同名函数——重定义会遮蔽公共库，又退回「副本靠注释对齐」。
KORE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/allow-dirs.sh
. "$KORE_SCRIPT_DIR/lib/allow-dirs.sh"

render_unit() {
  cat <<UNIT
[Unit]
Description=kore thin kernel
Documentation=file://$INSTALL_ROOT/docs/ARCHITECTURE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 零侵入（ADR-0023）：状态/日志/socket 都在安装根内；卸载走 kored uninstall
Environment=KORE_HOME=$INSTALL_ROOT
# 受控文件写的证书/口令目录白名单（ADR-0052 fail-closed）：未注入 = ssl_certificate* 一律拒绝。
# 值必须与 ssl 插件实际证书目录一致；改这里 = 调整 root 写面，不是普通配置项。
Environment=KORE_FILE_WRITE_ALLOW_DIRS=$FILE_WRITE_ALLOW_DIRS
ExecStart=$BIN serve
Restart=on-failure
RestartSec=2
TimeoutStopSec=15
KillMode=mixed
Delegate=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
}

UNIT_PATH="$UNIT_DIR/$UNIT_NAME"

resolve_allow_dirs "$INSTALL_ROOT"
# 白名单先校验再谈写 unit / dry-run 打印：非法值必须在这里就 exit 1。
validate_allow_dirs "$FILE_WRITE_ALLOW_DIRS" || exit 1

if [ ! -x "$BIN" ]; then
  echo "[FAIL] $BIN 不存在或不可执行（先 make build）" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "[FAIL] 未找到 systemctl（Alpine/容器请用前台模式：$BIN serve）" >&2
  exit 1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "kore systemd unit 安装计划（--dry-run，零变更）"
  echo "  unit 文件 : $UNIT_PATH"
  echo "  ExecStart : $BIN serve"
  echo "  KORE_HOME : $INSTALL_ROOT"
  echo "  受控写白名单: $FILE_WRITE_ALLOW_DIRS（ADR-0052 fail-closed；默认 <安装根>/data/ssl/）"
  echo
  echo "----- unit 内容（$UNIT_PATH）-----"
  render_unit
  echo "----- unit 内容结束 -----"
  echo "[DRY-RUN] 未写任何文件（真装请 sudo 执行同一命令，去掉 --dry-run）"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "[FAIL] 安装 systemd unit 需要 root：sudo make install" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
if ! render_unit >"$UNIT_PATH"; then
  echo "[FAIL] 写 unit 失败: $UNIT_PATH" >&2
  exit 2
fi

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"

echo "[OK] 已安装并启动 $UNIT_NAME（ExecStart=$BIN serve，KORE_HOME=$INSTALL_ROOT，KORE_FILE_WRITE_ALLOW_DIRS=$FILE_WRITE_ALLOW_DIRS）"
echo "[WARN] 这是 ADR-0023 §3.5 的**豁免 #1**：$UNIT_PATH 在安装目录外。"
echo "       卸载：sudo kored uninstall（或 sudo make uninstall）会 stop → disable → rm → daemon-reload。"
