#!/usr/bin/env bash
# 安装 systemd unit（ADR-0023 §3.5 豁免 #1；唯一被豁免的常规侵入）。
#
# 用法: scripts/install-service.sh <kored 绝对路径> <安装根> <unit 目录> <unit 名>
# 退出码: 0 成功 / 1 参数或权限 / 2 写 unit 失败
set -euo pipefail

BIN="${1:?用法: install-service.sh <kored 路径> <安装根> <unit 目录> <unit 名>}"
INSTALL_ROOT="${2:?缺安装根}"
UNIT_DIR="${3:-/etc/systemd/system}"
UNIT_NAME="${4:-kore.service}"

if [ ! -x "$BIN" ]; then
  echo "[FAIL] $BIN 不存在或不可执行（先 make build）" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "[FAIL] 安装 systemd unit 需要 root：sudo make install" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "[FAIL] 未找到 systemctl（Alpine/容器请用前台模式：$BIN serve）" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
if ! cat >"$UNIT_PATH" <<UNIT
[Unit]
Description=kore thin kernel
Documentation=file://$INSTALL_ROOT/docs/ARCHITECTURE.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# 零侵入（ADR-0023）：状态/日志/socket 都在安装根内；卸载走 kored uninstall
Environment=KORE_HOME=$INSTALL_ROOT
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
then
  echo "[FAIL] 写 unit 失败: $UNIT_PATH" >&2
  exit 2
fi

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME"

echo "[OK] 已安装并启动 $UNIT_NAME（ExecStart=$BIN serve，KORE_HOME=$INSTALL_ROOT）"
echo "[WARN] 这是 ADR-0023 §3.5 的**豁免 #1**：$UNIT_PATH 在安装目录外。"
echo "       卸载：sudo kored uninstall（或 sudo make uninstall）会 stop → disable → rm → daemon-reload。"
