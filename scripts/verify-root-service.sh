#!/usr/bin/env bash
# 一次性验证包：系统级 root 服务 + 自升级 / 自回滚零口令（ADR-0042 方案 B）。
#
# 用法:
#   bash scripts/verify-root-service.sh --dry-run                 # 只打印计划与期望输出，零变更
#   sudo bash scripts/verify-root-service.sh --yes                # 真跑（需要 root；会装系统级 unit 并重启服务）
#   sudo bash scripts/verify-root-service.sh --yes --password-file /root/.kore-admin
#   sudo bash scripts/verify-root-service.sh --yes --cookie /root/kore.cookies   # 用已有登录会话（推荐）
#   sudo bash scripts/verify-root-service.sh --rollback --dry-run  # 回滚计划
#   sudo bash scripts/verify-root-service.sh --rollback            # 停服务 + 删 unit + daemon-reload（幂等）
#
# 常用参数:
#   --install-root DIR   安装根（KORE_HOME，默认 /opt/kore）
#   --bin PATH           kored 路径（默认 <install-root>/bin/kored）
#   --unit-name NAME     unit 名（默认 kore；只允许字母数字 _ . @ -）
#   --cookie FILE        curl cookie jar（已登录的 kore 管理会话；用于 STEP 3 触发 root 动作）
#   --password-file FILE 管理员口令文件（0600；脚本自己登录，口令只进 curl 的 JSON 体，不进 argv/日志）
#   --root-action-plugin / --root-action-id   指定要触发的 root 动作（默认自动挑一个非 irreversible 的只读动作）
#   --no-unit-restart    STEP 4 用 --no-restart（不提交 systemctl restart；重启链路记 SKIP）
#   --keep-artifacts     保留 /tmp/kore-verify-root.* 证据目录（默认退出时清理）
#   --yes                真跑确认（没有它脚本不会做任何变更）
#
# 退出码: 0 全部闭环 / 1 参数、前置或某项检查 FAIL / 3 需要 root / 7 有步骤未闭环（如无登录会话、无 root 动作插件）
#
# 这个脚本做什么（按顺序，每步打印「做了什么 / 期望看到什么 / 实际看到什么」）:
#   STEP 1  调 scripts/install.sh 装 /etc/systemd/system/kore.service（User=root）并 enable --now
#   STEP 2  校验运行身份：systemctl show -p User = root、MainPID 的属主 = root
#   STEP 3  触发一次 root 动作，比较触发前后 `journalctl -u polkit | grep -c manage-units` 的差值应为 0
#   STEP 4  在 /tmp 假安装根上跑 `kored upgrade --bin --sha256`：查 .prev、upgrade-result.json pending → success
#   STEP 5  在同一个假安装根上跑 `kored upgrade --rollback`：切回旧 sha，.prev 变成新 sha（可再次切回）
#   STEP 6  `kored uninstall --dry-run` 预演 + 打印真跑会执行什么；**绝不真删服务**
#
# 这个脚本不做什么（边界，必须随评审）:
#   - 不写 ADR-0023 §3.5 之外的宿主路径：唯一宿主写入是豁免 #1 的 /etc/systemd/system/<unit>.service 与 enable 软链；
#     STEP 4/5 的目标、.prev、upgrade-result.json 全部在 /tmp 假安装根内，**不碰真实二进制**。
#   - 不执行自卸载（会删服务）。STEP 6 只跑 --dry-run 并打印会执行的命令。
#   - 不写死任何口令/密钥：口令只从 --password-file 读入内存并直接灌进 curl 的 JSON 请求体（不进 argv）。
#   - 不做通配符删除：所有删除路径先 readlink -f 归一化，且必须匹配本脚本的 /tmp 前缀，否则拒绝。
set -uo pipefail

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"

UNIT_NAME="kore"
INSTALL_ROOT=""
BIN=""
BIN_GIVEN=0
DRY_RUN=0
ROLLBACK=0
ASSUME_YES=0
COOKIE_FILE=""
PASSWORD_FILE=""
RA_PLUGIN=""
RA_ID=""
NO_UNIT_RESTART=0
KEEP_ARTIFACTS=0

PASS=0
FAIL=0
SKIP=0
STEP_OK=1
STEP_NO=0
UNIT_PATH=""
SOCKET=""
PW=""
COOKIE_JAR=""
TMP_DIRS=()
MARKER_NAME="upgrade-result.json"

usage() {
	cat <<'USAGE'
用法: bash scripts/verify-root-service.sh [--dry-run] [--yes] [选项]

  --dry-run              只打印每一步的 [DO]/[EXPECT]/[DRY-RUN]，不做任何变更
  --rollback             撤销本验证包对宿主的改动（停服务 + 删 unit + daemon-reload；幂等）
  --yes                  真跑确认（缺省只做前置检查并退出）
  --install-root DIR     安装根 / KORE_HOME（默认 /opt/kore）
  --bin PATH             kored 路径（默认 <install-root>/bin/kored）
  --unit-name NAME       systemd unit 名（默认 kore）
  --cookie FILE          curl cookie jar（已登录的管理会话）
  --password-file FILE   管理员口令文件（0600）；脚本自己登录
  --root-action-plugin P root 动作所属插件（默认自动挑选）
  --root-action-id A     root 动作 id（默认自动挑选非 irreversible 的动作）
  --no-unit-restart      STEP 4 不提交 systemctl restart（重启链路记 SKIP）
  --keep-artifacts       保留 /tmp/kore-verify-root.* 证据目录
  -h, --help             打印本帮助

退出码: 0 全部闭环 / 1 参数或检查失败 / 3 需要 root / 7 有步骤未闭环
USAGE
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--rollback) ROLLBACK=1 ;;
		--yes|-y) ASSUME_YES=1 ;;
		--install-root) shift; INSTALL_ROOT="${1:-}" ;;
		--install-root=*) INSTALL_ROOT="${1#*=}" ;;
		--bin) shift; BIN="${1:-}"; BIN_GIVEN=1 ;;
		--bin=*) BIN="${1#*=}"; BIN_GIVEN=1 ;;
		--unit-name) shift; UNIT_NAME="${1:-}" ;;
		--unit-name=*) UNIT_NAME="${1#*=}" ;;
		--cookie) shift; COOKIE_FILE="${1:-}" ;;
		--cookie=*) COOKIE_FILE="${1#*=}" ;;
		--password-file) shift; PASSWORD_FILE="${1:-}" ;;
		--password-file=*) PASSWORD_FILE="${1#*=}" ;;
		--root-action-plugin) shift; RA_PLUGIN="${1:-}" ;;
		--root-action-plugin=*) RA_PLUGIN="${1#*=}" ;;
		--root-action-id) shift; RA_ID="${1:-}" ;;
		--root-action-id=*) RA_ID="${1#*=}" ;;
		--no-unit-restart) NO_UNIT_RESTART=1 ;;
		--keep-artifacts) KEEP_ARTIFACTS=1 ;;
		-h|--help) usage; exit 0 ;;
		*) printf '[FAIL] 未知参数: %s\n' "$1" >&2; usage >&2; exit 1 ;;
	esac
	shift
done

# ---------------------------------------------------------------- 基础工具

info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
fail_out() { printf '[FAIL] %s\n' "$*" >&2; }

# canon 返回绝对路径（不存在时返回空，不创建任何东西）。
canon() { readlink -f -- "$1" 2>/dev/null || true; }

# safe_rm_tree 只删本脚本在 TMPROOT 下建的目录：先归一化，再校验前缀与通配符。
safe_rm_tree() {
	local p="$1" root="${TMPROOT%/}"
	if [ -z "$p" ] || [ "$p" = "/" ]; then
		fail_out "拒绝删除空路径或 /"
		return 1
	fi
	case "$p" in
		*'*'*|*'?'*|*'['*)
			fail_out "拒绝删除含通配符的路径: $p"
			return 1
			;;
	esac
	case "$p" in
		"$root"/kore-verify-root.*|"$root"/kore-verify-creds.*) ;;
		*)
			fail_out "拒绝删除非本脚本临时目录: $p（要求前缀 $root/kore-verify-*）"
			return 1
			;;
	esac
	rm -rf -- "$p"
}

cleanup() {
	local p
	if [ -n "${COOKIE_JAR:-}" ] && [ -f "$COOKIE_JAR" ]; then
		rm -f -- "$COOKIE_JAR"
	fi
	if [ "$KEEP_ARTIFACTS" -eq 1 ]; then
		if [ "${#TMP_DIRS[@]}" -gt 0 ]; then
			info "保留证据目录（--keep-artifacts）：${TMP_DIRS[*]}"
		fi
		return
	fi
	if [ "${#TMP_DIRS[@]}" -gt 0 ]; then
		for p in "${TMP_DIRS[@]}"; do
			safe_rm_tree "$p" || true
		done
	fi
}
trap cleanup EXIT INT TERM

step_begin() {
	STEP_NO=$((STEP_NO + 1))
	STEP_OK=1
	printf '\n===== STEP %s · %s =====\n' "$1" "$2"
}

# chk 打印一条「期望 / 实际」对照；不一致时把本步标成 FAIL。
chk() { # label actual expected
	printf '[CHECK]  %s\n[EXPECT] %s\n[ACTUAL] %s\n' "$1" "$3" "$2"
	if [ "$2" != "$3" ]; then
		STEP_OK=0
	fi
}

# chk_grep 在命令输出里找一个固定子串。
chk_grep() { # label haystack needle
	local hit="未命中"
	if printf '%s' "$2" | grep -qF -- "$3"; then
		hit="命中"
	fi
	printf '[CHECK]  %s\n[EXPECT] 输出含「%s」\n[ACTUAL] %s\n' "$1" "$3" "$hit"
	if [ "$hit" != "命中" ]; then
		STEP_OK=0
	fi
}

indent() { sed 's/^/         /'; }

finish_step() { # summary
	if [ "$STEP_OK" -eq 1 ]; then
		PASS=$((PASS + 1))
		printf '[RESULT] PASS — %s\n' "$1"
	else
		FAIL=$((FAIL + 1))
		printf '[RESULT] FAIL — %s\n' "$1"
	fi
}

skip_step() { # reason
	SKIP=$((SKIP + 1))
	printf '[RESULT] SKIP — %s\n' "$1"
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum -- "$1" | awk '{print $1}'
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 -- "$1" | awk '{print $NF}'
	else
		return 1
	fi
}

marker_state() {
	if [ ! -f "$1" ]; then
		printf ''
		return
	fi
	sed -n 's/.*"state":[[:space:]]*"\([a-z-]*\)".*/\1/p' "$1" | head -n1
}

polkit_manage_units_count() {
	journalctl -u polkit --since=-5min --no-pager 2>/dev/null | grep -c 'manage-units' || true
}

polkit_authfail_count() {
	journalctl -u polkit --since=-2min --no-pager 2>/dev/null | grep -c 'FAILED to authenticate' || true
}

wait_unit_active() { # timeout_seconds
	local deadline=$((SECONDS + $1))
	while [ "$SECONDS" -lt "$deadline" ]; do
		if [ "$(systemctl is-active "$UNIT_NAME" 2>/dev/null)" = "active" ]; then
			return 0
		fi
		sleep 0.5
	done
	return 1
}

# ---------------------------------------------------------------- 前置检查

case "$UNIT_NAME" in
	''|*[!A-Za-z0-9_.@-]*) fail_out "unit 名非法: '$UNIT_NAME'（只允许字母数字 _ . @ -）"; exit 1 ;;
esac

TMPROOT="$(canon "${TMPDIR:-/tmp}")"
if [ -z "$TMPROOT" ] || [ ! -d "$TMPROOT" ]; then
	fail_out "临时目录不可用: ${TMPDIR:-/tmp}"
	exit 1
fi

if [ -z "$INSTALL_ROOT" ]; then
	INSTALL_ROOT="/opt/kore"
fi
case "$INSTALL_ROOT" in
	/*) ;;
	*) fail_out "--install-root 必须是绝对路径: $INSTALL_ROOT"; exit 1 ;;
esac
if [ -d "$INSTALL_ROOT" ]; then
	INSTALL_ROOT="$(canon "$INSTALL_ROOT")"
fi

if [ -z "$BIN" ]; then
	BIN="$INSTALL_ROOT/bin/kored"
fi
case "$BIN" in
	/*) ;;
	*) fail_out "--bin 必须是绝对路径: $BIN"; exit 1 ;;
esac

UNIT_DIR="/etc/systemd/system"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME.service"
SOCKET="$INSTALL_ROOT/run/kore.sock"

if [ "$(id -u)" -ne 0 ] && [ "$DRY_RUN" -eq 0 ]; then
	info "安装根: $INSTALL_ROOT"
	info "unit  : $UNIT_PATH"
	fail_out "真跑与 --rollback 都需要 root（脚本不自行提权）："
	printf '  sudo bash %q --yes%s\n' "$SCRIPT_PATH" "${COOKIE_FILE:+ --cookie $COOKIE_FILE}"
	printf '  只读预演：bash %q --dry-run\n' "$SCRIPT_PATH"
	exit 3
fi

if [ "$DRY_RUN" -eq 0 ]; then
	if [ ! -d "$INSTALL_ROOT" ]; then
		fail_out "安装根不存在: $INSTALL_ROOT（先用 make build / 解压发行包；或用 --install-root 指定）"
		exit 1
	fi
	if [ ! -x "$BIN" ]; then
		fail_out "kored 不可执行: $BIN（先 make build，或用 --bin 指定）"
		exit 1
	fi
	BIN="$(canon "$BIN")"
	if [ -z "$BIN" ]; then
		fail_out "无法解析 --bin 路径"
		exit 1
	fi
	if [ ! -d "$UNIT_DIR" ]; then
		fail_out "缺少 $UNIT_DIR：本机不是 systemd 环境，本验证包不适用"
		exit 1
	fi
	if ! command -v systemctl >/dev/null 2>&1; then
		fail_out "未找到 systemctl：本机不是 systemd 环境，本验证包不适用"
		exit 1
	fi
	if [ ! -f "$INSTALL_SH" ]; then
		fail_out "缺少 $INSTALL_SH（本脚本依赖它渲染 unit，避免两份 unit 漂移）"
		exit 1
	fi
	if [ "$ROLLBACK" -eq 0 ] && [ "$ASSUME_YES" -ne 1 ]; then
		printf '[BLOCKED] 真跑会安装系统级 unit 并重启服务；确认请加 --yes\n'
		printf '  预览：bash %q --dry-run\n' "$SCRIPT_PATH"
		exit 1
	fi
fi

printf 'kore 系统级 root 服务 · 一次性验证包（ADR-0042 方案 B）\n'
printf '  安装根   : %s\n' "$INSTALL_ROOT"
printf '  kored    : %s%s\n' "$BIN" "$([ "$BIN_GIVEN" -eq 1 ] && printf '（--bin）' || printf '（默认推导）')"
printf '  unit     : %s（ADR-0023 §3.5 豁免 #1）\n' "$UNIT_PATH"
printf '  模式     : %s\n' "$([ "$ROLLBACK" -eq 1 ] && printf 'rollback' || printf 'verify')"
printf '  环境     : uid=%s · systemd=%s\n' "$(id -u)" "$(systemctl --version 2>/dev/null | head -n1 || printf '未知')"

# ---------------------------------------------------------------- 回滚模式

restore_user_unit_hint() {
	local user="${SUDO_USER:-}"
	printf '\n[回滚] 恢复原来的用户级实例（在原用户的图形会话里执行，非 root）：\n'
	printf '  systemctl --user daemon-reload\n'
	printf '  systemctl --user enable --now kored-local\n'
	if [ -n "$user" ]; then
		printf '\n  或者由 root 代跑（XDG_RUNTIME_DIR 必须是该用户的）：\n'
		printf '  runuser -u %s -- env XDG_RUNTIME_DIR=/run/user/%s systemctl --user enable --now kored-local\n' "$user" "$(id -u "$user" 2>/dev/null || printf '<uid>')"
	fi
	printf '\n[回滚] 系统级服务以 root 写过安装根内的 state/run/logs，交还原用户属主（按需）：\n'
	if [ -n "$user" ]; then
		printf '  chown -R %s:%s %q %q %q\n' "$user" "$user" "$INSTALL_ROOT/data" "$INSTALL_ROOT/run" "$INSTALL_ROOT/logs"
	else
		printf '  chown -R <user>:<user> %q %q %q\n' "$INSTALL_ROOT/data" "$INSTALL_ROOT/run" "$INSTALL_ROOT/logs"
	fi
}

if [ "$ROLLBACK" -eq 1 ]; then
	step_begin "R1/2" "停服务并删除系统级 unit（幂等）"
	printf '[DO]     bash %q --remove --install-root %q --name %q\n' "$INSTALL_SH" "$INSTALL_ROOT" "$UNIT_NAME"
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[EXPECT] exit 0；打印 "[OK] 已停止 %s" 与 "[OK] 已删除 %s 并 daemon-reload（幂等）"\n' "$UNIT_NAME" "$UNIT_PATH"
		printf '[EXPECT] unit 不存在时打印 "[OK] unit 不存在，无需卸载（幂等）"\n'
		printf '[DRY-RUN] 未执行（零变更）\n'
		finish_step "回滚计划正确（dry-run 不验证真实行为）"
	else
		out="$(bash "$INSTALL_SH" --remove --install-root "$INSTALL_ROOT" --name "$UNIT_NAME" 2>&1)"
		rc=$?
		printf '[ACTUAL] exit %d\n' "$rc"
		printf '%s\n' "$out" | indent
		if [ "$rc" -ne 0 ]; then
			STEP_OK=0
		fi
		chk "test -e $UNIT_PATH" "$([ -e "$UNIT_PATH" ] && printf '存在' || printf '不存在')" "不存在"
		chk "systemctl is-active $UNIT_NAME" "$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)" "inactive"
		finish_step "系统级 unit 已移除，宿主回到「只有用户级实例」的形态"
	fi
	restore_user_unit_hint
	printf '\n===== 摘要 =====\n'
	printf '  PASS %d / FAIL %d / SKIP %d\n' "$PASS" "$FAIL" "$SKIP"
	if [ "$FAIL" -gt 0 ]; then
		exit 1
	fi
	exit 0
fi

# ---------------------------------------------------------------- 真跑编排

step1_install() {
	step_begin "1/6" "安装系统级 root unit 并启动（User=root）"
	printf '[DO]     bash %q --install-root %q --bin %q --name %q\n' "$INSTALL_SH" "$INSTALL_ROOT" "$BIN" "$UNIT_NAME"
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[EXPECT] exit 0；"[OK] 已写入 %s"\n' "$UNIT_PATH"
		printf '[EXPECT] 重复运行时 "[OK] unit 已是最新（幂等）"（不重写、不重启）\n'
		printf '[DRY-RUN] 未执行（零变更）\n'
		printf '[RESULT] PASS — 计划正确（dry-run 不验证真实行为）\n'
		return 0
	fi
	out="$(bash "$INSTALL_SH" --install-root "$INSTALL_ROOT" --bin "$BIN" --name "$UNIT_NAME" 2>&1)"
	rc=$?
	printf '[ACTUAL] exit %d\n' "$rc"
	printf '%s\n' "$out" | indent
	if [ "$rc" -ne 0 ]; then
		STEP_OK=0
		finish_step "系统级 unit 安装失败（看上方输出）"
		return 1
	fi
	chk "systemctl is-active $UNIT_NAME" "$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)" "active"
	chk "systemctl show -p User --value $UNIT_NAME" "$(systemctl show -p User --value "$UNIT_NAME" 2>/dev/null || true)" "root"
	chk "test -f $UNIT_PATH" "$([ -f "$UNIT_PATH" ] && printf '存在' || printf '不存在')" "存在"
	finish_step "系统级 unit 已就位并 active（User=root）"
	if [ "$STEP_OK" -eq 0 ]; then
		return 1
	fi
	return 0
}

step2_identity() {
	step_begin "2/6" "核验运行身份：主进程属主必须是 root"
	local pid ps_user comm kored_users
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[DO]     systemctl show -p MainPID --value %s\n' "$UNIT_NAME"
		printf '[DO]     ps -o user= -p <MainPID>；ps -o comm= -p <MainPID>；ps -eo user=,comm= | awk '\''$2=="kored"'\'' | sort -u\n'
		printf '[EXPECT] MainPID > 0、属主 root、comm kored，且没有非 root 的 kored 实例\n'
		printf '[DRY-RUN] 未执行（零变更）\n'
		printf '[RESULT] PASS — 计划正确（dry-run 不验证真实行为）\n'
		return 0
	fi
	pid="$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)"
	printf '[DO]     systemctl show -p MainPID --value %s\n' "$UNIT_NAME"
	printf '[EXPECT] MainPID > 0（进程已起来）\n'
	printf '[ACTUAL] %s\n' "${pid:-<空>}"
	if [ -z "$pid" ] || [ "$pid" = "0" ]; then
		STEP_OK=0
	fi
	ps_user="$(ps -o user= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
	chk "ps -o user= -p $pid" "$ps_user" "root"
	comm="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
	chk "ps -o comm= -p $pid" "$comm" "kored"
	kored_users="$(ps -eo user=,comm= | awk '$2=="kored"{print $1}' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
	chk "ps -eo user=,comm= | awk '\$2==\"kored\"' | sort -u" "$kored_users" "root"
	finish_step "kored 以 root 运行（且没有非 root 的 kored 实例在跑）"
}

step3_polkit() {
	step_begin "3/6" "触发一次 root 动作，确认不走 polkit（manage-units 差值 = 0）"
	local before after delta actionfail trigger_ok=0 fallback=0
	before="$(polkit_manage_units_count)"
	printf '[DO]     journalctl -u polkit --since=-5min --no-pager | grep -c manage-units\n'
	printf '[EXPECT] 触发前计数（通常是 0）\n'
	printf '[ACTUAL] %s\n' "$before"

	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[DO]     POST http://kore/api/v1/plugins/<plugin>/root-action（经 %s）\n' "$SOCKET"
		printf '[EXPECT] HTTP 200、executed=true、unit 非空（kore-root-<plugin>-<action>-<rand8>）；exit_code 由动作本身决定\n'
		printf '[EXPECT] 触发后再数 manage-units：期望 0（与触发前相比差值 0）\n'
		printf '[DRY-RUN] 未执行（零变更）\n'
		printf '[CHECK]  触发前的绝对计数已打印；真跑会打印差值\n'
		printf '[RESULT] PASS — 计划正确（dry-run 不验证真实行为）\n'
		return 0
	fi

	if [ ! -S "$SOCKET" ]; then
		skip_step "socket 不存在: $SOCKET（服务未起来或无权限；修好 STEP 1 后重跑）"
		return 0
	fi
	if ! command -v curl >/dev/null 2>&1; then
		skip_step "缺少 curl，无法触发 root 动作"
		return 0
	fi

	if [ -z "$COOKIE_FILE" ] && [ -n "$PASSWORD_FILE" ]; then
		if [ ! -r "$PASSWORD_FILE" ]; then
			skip_step "口令文件不可读: $PASSWORD_FILE"
			return 0
		fi
		if ! command -v python3 >/dev/null 2>&1; then
			skip_step "缺少 python3，无法安全构造登录 JSON（改用 --cookie）"
			return 0
		fi
		COOKIE_JAR="$(mktemp "$TMPROOT/kore-verify-creds.XXXXXX")" || {
			skip_step "无法创建 cookie jar"
			return 0
		}
		chmod 0600 "$COOKIE_JAR"
		PW="$(cat -- "$PASSWORD_FILE")"
		printf '[DO]     POST /api/v1/auth/login（口令来自 %s，不进 argv，不打印）\n' "$PASSWORD_FILE"
		code="$(printf '%s' "$PW" | python3 -c 'import json,sys; print(json.dumps({"password": sys.stdin.read().rstrip("\n")}))' |
			curl -sS --unix-socket "$SOCKET" -c "$COOKIE_JAR" -H 'Content-Type: application/json' \
				--data-binary @- -o /dev/null -w '%{http_code}' http://kore/api/v1/auth/login || true)"
		PW=""
		printf '[EXPECT] HTTP 200（进入已登录会话）\n'
		printf '[ACTUAL] HTTP %s\n' "${code:-<无响应>}"
		if [ "$code" != "200" ]; then
			skip_step "登录失败 HTTP ${code:-无响应}（口令错误？见 journalctl -u $UNIT_NAME）"
			return 0
		fi
	fi

	if [ -n "$COOKIE_FILE" ]; then
		if [ ! -r "$COOKIE_FILE" ]; then
			skip_step "cookie 文件不可读: $COOKIE_FILE"
			return 0
		fi
		if ! command -v python3 >/dev/null 2>&1; then
			skip_step "缺少 python3，无法解析插件列表（改用 --root-action-plugin/--root-action-id）"
			return 0
		fi
		COOKIE_ARG=(-b "$COOKIE_FILE")
	elif [ -n "$COOKIE_JAR" ]; then
		COOKIE_ARG=(-b "$COOKIE_JAR")
	else
		# 没有会话：只做机制等价自检（uid=0 直连 systemd），并明确标注不是 kore 动作。
		fallback=1
		printf '[FALLBACK] 未提供 --cookie / --password-file：不做 HTTP 登录，改用 systemd-run 做机制等价自检\n'
		printf '[DO]     systemd-run --uid=0 --collect --wait --quiet true\n'
		printf '[EXPECT] exit 0（uid=0 不进入 polkit 判定）\n'
		sr_out="$(systemd-run --uid=0 --collect --wait --quiet true 2>&1)"
		sr_rc=$?
		printf '[ACTUAL] exit %d%s\n' "$sr_rc" "${sr_out:+：$sr_out}"
		if [ "$sr_rc" -eq 0 ]; then
			trigger_ok=1
		fi
	fi

	if [ "$fallback" -eq 0 ]; then
		plugins_json="$(curl -sS --unix-socket "$SOCKET" "${COOKIE_ARG[@]}" http://kore/api/v1/plugins 2>/dev/null || true)"
		pick="$(printf '%s' "$plugins_json" | python3 -c '
import json, sys
want_p, want_a = sys.argv[1], sys.argv[2]
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
plugins = data.get("plugins", data) if isinstance(data, dict) else data
cands = []
for p in plugins or []:
    for a in p.get("root_actions") or []:
        if a.get("irreversible"):
            continue
        cands.append((p.get("id", ""), a.get("id", "")))
if want_p and want_a:
    print(want_p + " " + want_a); raise SystemExit(0)
def rank(c):
    aid = c[1]
    return 0 if ("status" in aid or "list" in aid) else 1
cands.sort(key=rank)
if not cands:
    raise SystemExit(3)
print(cands[0][0] + " " + cands[0][1])
' "$RA_PLUGIN" "$RA_ID" 2>/dev/null || true)"
		if [ -z "$pick" ]; then
			skip_step "没有可用的非 irreversible root 动作（装一个声明 root_actions 的插件，或用 --root-action-plugin/--root-action-id 指定）"
			return 0
		fi
		pick_plugin="${pick%% *}"
		pick_action="${pick#* }"
		printf '[DO]     POST http://kore/api/v1/plugins/%s/root-action {"action_id":"%s"}\n' "$pick_plugin" "$pick_action"
		printf '[EXPECT] HTTP 200、executed=true、unit 形如 kore-root-%s-%s-<rand8>；exit_code 由动作本身决定\n' "$pick_plugin" "$pick_action"
		resp="$(curl -sS --unix-socket "$SOCKET" "${COOKIE_ARG[@]}" -H 'Content-Type: application/json' \
			-d "{\"action_id\":\"$pick_action\"}" "http://kore/api/v1/plugins/$pick_plugin/root-action" 2>&1 || true)"
		printf '[ACTUAL] %s\n' "$resp"
		parsed="$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("parse-failed"); raise SystemExit(0)
print("executed=%s exit_code=%s unit=%s" % (d.get("executed"), d.get("exit_code"), d.get("unit") or ""))
' 2>/dev/null || printf 'parse-failed')"
		printf '[ACTUAL] %s\n' "$parsed"
		case "$parsed" in
			executed=True*unit=kore-root-*) trigger_ok=1 ;;
			*) trigger_ok=0 ;;
		esac
	fi

	after="$(polkit_manage_units_count)"
	delta=$((after - before))
	actionfail="$(polkit_authfail_count)"
	printf '[CHECK]  触发后 manage-units 计数\n'
	printf '[EXPECT] %s（与触发前相同）\n' "$before"
	printf '[ACTUAL] %s\n' "$after"
	printf '[CHECK]  触发前 → 触发后的差值\n'
	printf '[EXPECT] 0\n'
	printf '[ACTUAL] %s\n' "$delta"
	printf '[CHECK]  journalctl -u polkit --since=-2min | grep -c "FAILED to authenticate"\n'
	printf '[EXPECT] 0\n'
	printf '[ACTUAL] %s\n' "$actionfail"
	if [ "$delta" -ne 0 ] || [ "$actionfail" -ne 0 ]; then
		STEP_OK=0
	fi
	if [ "$trigger_ok" -ne 1 ]; then
		STEP_OK=0
	fi
	if [ "$fallback" -eq 1 ]; then
		# 机制自检通过不代表 kore 动作已验证：降级为 SKIP，不谎报 PASS。
		if [ "$STEP_OK" -eq 1 ]; then
			skip_step "polkit 机制自检通过（manage-units 差值 0），但未触发 kore root 动作（缺 --cookie/--password-file）"
		else
			finish_step "polkit 自检未通过（看上方计数）"
		fi
		return 0
	fi
	finish_step "root 动作零交互执行，且 polkit 没有 manage-units 判定"
}

step4_fake_upgrade() {
	step_begin "4/6" "假安装根上跑 kored upgrade：.prev + upgrade-result pending → success"
	local fake new_bin old_sha new_sha out rc pid_before pid_after
	printf '[DO]     在 %s/kore-verify-root.XXXXXX 下建假安装根（bin/ + data/），不碰真实二进制\n' "$TMPROOT"
	printf '[EXPECT] .prev 存在且内容 = 升级前 sha；upgrade-result.json 先 pending、--verify 后 success\n'
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[DO]     %q upgrade --bin <假>/new-kored --sha256 <新 sha> --target <假>/bin/kored --state-dir <假>/data --unit-name %s\n' "$BIN" "$UNIT_NAME"
		printf '[EXPECT] exit 0；"[OK] 已原子替换"、"[INFO] 已落 pending 标记"、"[OK] 已提交重启：systemctl --no-block restart %s"\n' "$UNIT_NAME"
		printf '[EXPECT] <假>/bin/kored.prev 存在；upgrade-result.json 的 state 从 pending 变 success\n'
		printf '[DRY-RUN] 未执行（零变更）\n'
		printf '[RESULT] PASS — 计划正确（dry-run 不验证真实行为）\n'
		return 0
	fi
	fake="$(mktemp -d "$TMPROOT/kore-verify-root.XXXXXX")" || {
		STEP_OK=0
		finish_step "无法创建临时目录"
		return 0
	}
	fake="$(canon "$fake")"
	case "$fake" in
		"$TMPROOT"/kore-verify-root.*) ;;
		*)
			safe_rm_tree "$fake" || true
			STEP_OK=0
			finish_step "临时目录不在预期前缀下，已清理"
			return 0
			;;
	esac
	TMP_DIRS+=("$fake")
	mkdir -p "$fake/bin" "$fake/data"
	cp -- "$BIN" "$fake/bin/kored"
	chmod 0755 "$fake/bin/kored"
	new_bin="$fake/new-kored"
	cp -- "$BIN" "$new_bin"
	printf '\n# kore verify placeholder（本文件只做升级对象，永不执行）\n' >>"$new_bin"
	old_sha="$(sha256_of "$fake/bin/kored" || true)"
	new_sha="$(sha256_of "$new_bin" || true)"
	printf '[INFO] 假安装根：%s\n' "$fake"
	printf '[INFO] 旧 sha256：%s\n' "$old_sha"
	printf '[INFO] 新 sha256：%s（内容有差异，才能验证 .prev 与回滚）\n' "$new_sha"
	if [ -z "$old_sha" ] || [ -z "$new_sha" ] || [ "$old_sha" = "$new_sha" ]; then
		STEP_OK=0
		finish_step "sha256 计算失败或新旧相同"
		return 0
	fi

	pid_before="$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)"
	restart_arg=""
	if [ "$NO_UNIT_RESTART" -eq 1 ]; then
		restart_arg="--no-restart"
	fi
	out="$("$BIN" upgrade --bin "$new_bin" --sha256 "$new_sha" \
		--target "$fake/bin/kored" --state-dir "$fake/data" --unit-name "$UNIT_NAME" $restart_arg 2>&1)"
	rc=$?
	printf '[ACTUAL] upgrade exit %d\n' "$rc"
	printf '%s\n' "$out" | indent
	if [ "$rc" -ne 0 ]; then
		STEP_OK=0
	fi
	chk_grep "upgrade 输出" "$out" "校验通过"
	chk_grep "upgrade 输出" "$out" "[OK] 已原子替换"
	chk_grep "upgrade 输出" "$out" "[INFO] 已落 pending 标记"
	chk "$fake/bin/kored 的 sha256" "$(sha256_of "$fake/bin/kored" || true)" "$new_sha"
	chk "$fake/bin/kored.prev 存在" "$([ -f "$fake/bin/kored.prev" ] && printf '存在' || printf '不存在')" "存在"
	chk "$fake/bin/kored.prev 的 sha256（旧版）" "$(sha256_of "$fake/bin/kored.prev" 2>/dev/null || true)" "$old_sha"
	chk "upgrade-result 初始 state" "$(marker_state "$fake/data/$MARKER_NAME")" "pending"

	if [ "$NO_UNIT_RESTART" -eq 1 ]; then
		chk_grep "upgrade 输出（--no-restart）" "$out" "[INFO] --no-restart"
		skip_step "STEP 4 已完成替换与 pending 标记，但按 --no-unit-restart 未提交重启（重启链路未验证）"
		return 0
	fi
	chk_grep "upgrade 输出（重启已提交）" "$out" "[OK] 已提交重启：systemctl --no-block restart $UNIT_NAME"
	if ! wait_unit_active 30; then
		STEP_OK=0
		printf '[ACTUAL] %s 在 30s 内没有回到 active\n' "$UNIT_NAME"
	else
		printf '[CHECK]  systemctl is-active %s（重启后）\n[EXPECT] active\n[ACTUAL] %s\n' "$UNIT_NAME" "$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)"
		printf '[CHECK]  systemctl show -p User --value %s（重启后）\n[EXPECT] root\n[ACTUAL] %s\n' "$UNIT_NAME" "$(systemctl show -p User --value "$UNIT_NAME" 2>/dev/null || true)"
		pid_after="$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || true)"
		printf '[CHECK]  MainPID 变化（证明真的重启了）\n[EXPECT] 与 %s 不同\n[ACTUAL] %s\n' "${pid_before:-<空>}" "${pid_after:-<空>}"
		if [ -z "$pid_after" ] || [ "$pid_after" = "$pid_before" ]; then
			STEP_OK=0
		fi
	fi

	out="$("$BIN" upgrade --verify --target "$fake/bin/kored" --state-dir "$fake/data" 2>&1)"
	rc=$?
	printf '[DO]     %q upgrade --verify --target <假>/bin/kored --state-dir <假>/data\n' "$BIN"
	printf '[EXPECT] exit 0；"[INFO] 升级已生效：…（upgrade-result=success）"\n'
	printf '[ACTUAL] exit %d\n' "$rc"
	printf '%s\n' "$out" | indent
	if [ "$rc" -ne 0 ]; then
		STEP_OK=0
	fi
	chk_grep "upgrade --verify 输出" "$out" "升级已生效"
	chk "upgrade-result 最终 state" "$(marker_state "$fake/data/$MARKER_NAME")" "success"
	finish_step "升级链闭环：.prev 保留旧版，pending 被 --verify 改写为 success"
}

step5_rollback() {
	step_begin "5/6" "假安装根上跑 kored upgrade --rollback：切回旧 sha，.prev 变新 sha"
	local fake new_sha out rc
	printf '[DO]     找到本次 STEP 4 的假安装根（%s/kore-verify-root.*）里的 .prev 与标记\n' "$TMPROOT"
	printf '[EXPECT] 目标 sha 回到旧值；.prev 变成 STEP 4 的新 sha（可再次 --rollback 切回）\n'
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[DO]     %q upgrade --rollback --target <假>/bin/kored --state-dir <假>/data --no-restart\n' "$BIN"
		printf '[EXPECT] exit 0；"[OK] 已回滚：…（替换前的二进制已存回 .prev，可再次 --rollback 切回）"\n'
		printf '[EXPECT] 目标 sha = 升级前 sha；.prev sha = 升级后 sha；state = rollback-pending → --verify 后 success\n'
		printf '[DRY-RUN] 未执行（零变更）\n'
		printf '[RESULT] PASS — 计划正确（dry-run 不验证真实行为）\n'
		return 0
	fi
	fake="${TMP_DIRS[0]:-}"
	if [ -z "$fake" ] || [ ! -f "$fake/bin/kored.prev" ]; then
		skip_step "没有本次运行的假安装根（STEP 4 未执行或已失败）"
		return 0
	fi
	new_sha="$(sha256_of "$fake/bin/kored" 2>/dev/null || true)"
	out="$("$BIN" upgrade --rollback --target "$fake/bin/kored" --state-dir "$fake/data" --no-restart 2>&1)"
	rc=$?
	printf '[ACTUAL] rollback exit %d\n' "$rc"
	printf '%s\n' "$out" | indent
	if [ "$rc" -ne 0 ]; then
		STEP_OK=0
	fi
	chk_grep "rollback 输出" "$out" "[OK] 已回滚"
	chk "rollback 后 .prev 的 sha256（= STEP 4 的新版）" "$(sha256_of "$fake/bin/kored.prev" 2>/dev/null || true)" "$new_sha"
	chk "rollback 后 state" "$(marker_state "$fake/data/$MARKER_NAME")" "rollback-pending"
	printf '[CHECK]  再次切回所需的命令（本脚本不执行）\n'
	printf '[EXPECT] 同一条 --rollback 会把 .prev（新版）换回来\n'
	printf '[ACTUAL] %q upgrade --rollback --target %q --state-dir %q --no-restart\n' "$BIN" "$fake/bin/kored" "$fake/data"

	out="$("$BIN" upgrade --verify --target "$fake/bin/kored" --state-dir "$fake/data" 2>&1)"
	rc=$?
	printf '[DO]     %q upgrade --verify（回滚后复核）\n' "$BIN"
	printf '[EXPECT] exit 0；state 从 rollback-pending 变 success\n'
	printf '[ACTUAL] exit %d\n' "$rc"
	printf '%s\n' "$out" | indent
	if [ "$rc" -ne 0 ]; then
		STEP_OK=0
	fi
	chk "回滚后最终 state" "$(marker_state "$fake/data/$MARKER_NAME")" "success"
	finish_step "回滚链闭环：目标切回旧版，.prev 保留新版可再切"
}

step6_uninstall_preview() {
	step_begin "6/6" "自卸载只预演（不执行）：kored uninstall --dry-run"
	local out rc
	printf '[DO]     env KORE_HOME=%q %q uninstall --dry-run\n' "$INSTALL_ROOT" "$BIN"
	printf '[EXPECT] exit 0；"[DRY-RUN] 以下仅为计划，不做任何变更"；unit 清理计划与"状态目录保留"提示\n'
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[EXPECT] 输出含 "[DRY-RUN] 以下仅为计划，不做任何变更" 与 "[PURGE] 未指定 --purge：状态目录保留"\n'
		printf '[DRY-RUN] 未执行（零变更）\n'
		printf '[RESULT] PASS — 计划正确（dry-run 不验证真实行为）\n'
		return 0
	fi
	out="$(env KORE_HOME="$INSTALL_ROOT" "$BIN" uninstall --dry-run 2>&1)"
	rc=$?
	printf '[ACTUAL] exit %d\n' "$rc"
	printf '%s\n' "$out" | indent
	if [ "$rc" -ne 0 ]; then
		STEP_OK=0
	fi
	chk_grep "uninstall --dry-run 输出" "$out" "[DRY-RUN] 以下仅为计划，不做任何变更"
	chk_grep "uninstall --dry-run 输出（状态目录保护）" "$out" "未指定 --purge：状态目录保留"
	chk "预演后 $UNIT_PATH 仍存在（证明没有真删）" "$([ -e "$UNIT_PATH" ] && printf '存在' || printf '不存在')" "存在"

	printf '\n[WOULD-RUN] 真卸载会执行（本脚本**不执行**，会删服务）：\n'
	printf '  env KORE_HOME=%q %q uninstall --yes\n' "$INSTALL_ROOT" "$BIN"
	printf '  systemctl disable --now %s\n' "$UNIT_NAME"
	printf '  rm -f %s && systemctl daemon-reload\n' "$UNIT_PATH"
	printf '[NOT-EXECUTED] 自卸载未执行：删掉 unit 就回不到 STEP 1-5 的验证现场；真要卸载请用户自己跑上面第一条。\n'
	finish_step "自卸载完成预演（零删除）"
}

if [ "$DRY_RUN" -eq 1 ]; then
	step1_install
	step2_identity
	step3_polkit
	step4_fake_upgrade
	step5_rollback
	step6_uninstall_preview
	printf '\n[DRY-RUN] 计划完成：未安装 unit、未重启服务、未替换任何二进制、未删除任何文件。\n'
	printf '[DRY-RUN] 真跑：sudo bash %q --yes%s\n' "$SCRIPT_PATH" "${COOKIE_FILE:+ --cookie $COOKIE_FILE}${PASSWORD_FILE:+ --password-file $PASSWORD_FILE}"
	exit 0
fi

if ! step1_install; then
	printf '\n===== 摘要 =====\n  [ABORT] STEP 1 失败：后面的步骤依赖系统级 unit，已停止。\n'
	printf '  PASS %d / FAIL %d / SKIP %d\n' "$PASS" "$FAIL" "$SKIP"
	exit 1
fi
step2_identity
step3_polkit
step4_fake_upgrade
step5_rollback
step6_uninstall_preview

printf '\n===== 摘要 =====\n'
printf '  PASS %d / FAIL %d / SKIP %d\n' "$PASS" "$FAIL" "$SKIP"
printf '  撤销本次验证（停服务 + 删 unit）：sudo bash %q --rollback\n' "$SCRIPT_PATH"
if [ "$FAIL" -gt 0 ]; then
	printf '  结论：有检查 FAIL（见上方 [RESULT] FAIL 行）\n'
	exit 1
fi
if [ "$SKIP" -gt 0 ]; then
	printf '  结论：已闭环 %d 项，另有 %d 项未闭环（见上方 [RESULT] SKIP 行）；补齐后重跑。\n' "$PASS" "$SKIP"
	exit 7
fi
printf '  结论：全部闭环——系统级 root 服务 + 自升级/自回滚零口令。\n'
exit 0
