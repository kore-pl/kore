#!/usr/bin/env bash
# 安装 polkit 规则：让 kore 服务用户对 org.freedesktop.systemd1.manage-units
# 在 kore-root-* 前缀的 transient unit 上**免口令**（ADR-0018 的 systemd-run 通道）。
#
# 用法:
#   scripts/install-polkit-rule.sh --dry-run [--user NAME]    # 只打印规则与目标路径，不写
#   scripts/install-polkit-rule.sh --check   [--user NAME]    # dry-run + node 语法/功能自检
#   scripts/install-polkit-rule.sh           [--user NAME]    # 真装（需 root；幂等）
#   scripts/install-polkit-rule.sh --remove  [--user NAME]    # 卸载（需 root；幂等）
#
# 退出码: 0 成功/已是最新 / 1 参数或环境错误 / 3 需要 root 才能真装
#
# ── 安全边界（必须随脚本一起评审，不得删改）──────────────────────────────
# 这条规则等价于：「<kore 服务用户> 可以**无视口令**、以**任意 uid（含 uid=0）**
# 启动/终止名字匹配 kore-root-* 的 systemd 单元」。它本身是一种**产品级提权**，
# 不是"配置小改"。
#
# 与 ADR-0018 的关系：ADR-0018 选了「内核代理 + systemd transient unit」，
# 但没规定"谁来授权"。本规则把授权从「每次操作弹 polkit 口令框」改成
# 「安装时一次性授权 + 可审计的 unit 名白名单」：
#   - 授权发生点：一次性，安装这条规则的时刻（运维显式执行本脚本）；
#   - 授权范围：只对该用户名、只对 manage-units、只对 start/stop/kill/reset-failed、
#     只对 kore-root-* 单元名；其余一律 NOT_HANDLED，走系统默认 auth_admin；
#   - 审计点：unit 名里带插件 id + 动作 id（kore-root-<plugin>-<action>-<rand8>），
#     journal 里 `systemd-run`/`polkitd`/kored 审计三方可对上发起者与动作。
# 不装这条规则 → 普通用户跑 kored 时每次 root 动作都要求输入管理员口令
# （实测：`systemd-run --uid=0 --pipe true` → Access denied / 交互认证），
# 产品无法满足用户「零口令」裁决；装了 → 本机该用户获得上述白名单提权。
#
# 最小权限（缺一条即 NOT_HANDLED，绝不无条件 YES）：
#   ① action.id 必须是 org.freedesktop.systemd1.manage-units
#   ② subject.user 必须是安装时指定的那个服务用户（按用户名，不按组、不通配）
#   ③ subject.local && subject.active：只认本机活动会话（远程/会话不活动不放行）
#   ④ action.lookup("verb") ∈ {start, kill, stop, reset-failed}
#   ⑤ action.lookup("unit") 匹配 ^kore-root-<plugin>-<action>(-<8hex>)?\.service$
set -euo pipefail

RULE_NAME="49-kore.rules"
SERVICE_USER=""
MODE="install"

usage() {
  sed -n '2,15p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --check)   MODE="check" ;;
    --remove)  MODE="remove" ;;
    --user)    shift; SERVICE_USER="${1:-}" ;;
    --user=*)  SERVICE_USER="${1#--user=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[FAIL] 未知参数: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [ -z "$SERVICE_USER" ]; then
  if [ -n "${SUDO_USER:-}" ]; then SERVICE_USER="$SUDO_USER"; else SERVICE_USER="$(id -un)"; fi
fi
if [ "$SERVICE_USER" = "root" ]; then
  echo "[FAIL] 规则不能写给 root（root 本就绕过 polkit）。用 --user <kore 服务运行用户>" >&2
  exit 1
fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "[FAIL] 用户不存在: $SERVICE_USER" >&2
  exit 1
fi

if ! command -v pkaction >/dev/null 2>&1; then
  echo "[FAIL] 未找到 pkaction：本机没有 polkit，无法安装免口令规则（非 systemd+polkit 环境请用前台模式）" >&2
  exit 1
fi

# 规则目录按本机实际存在的选：优先管理员本地目录 /etc，次选发行版目录 /usr/share。
if [ -d /etc/polkit-1/rules.d ]; then
  RULES_DIR="/etc/polkit-1/rules.d"
elif [ -d /usr/share/polkit-1/rules.d ]; then
  RULES_DIR="/usr/share/polkit-1/rules.d"
else
  echo "[FAIL] 未找到 /etc/polkit-1/rules.d 或 /usr/share/polkit-1/rules.d" >&2
  exit 1
fi
RULE_PATH="$RULES_DIR/$RULE_NAME"

render_rule() {
  cat <<RULE
// $RULE_PATH — kore root-action 免口令通道（ADR-0018 / G-31）
// 安装: scripts/install-polkit-rule.sh --user $SERVICE_USER
// 卸载: scripts/install-polkit-rule.sh --remove
//
// 安全边界：本规则等价于「$SERVICE_USER 可免口令、以任意 uid（含 uid=0）
// 启动/终止名为 kore-root-* 的 systemd transient unit」——这是产品级提权。
// 与 ADR-0018 的关系：把"谁来授权"从每次弹口令改成本次安装的一次性授权，
// 授权范围由 unit 名白名单收敛，发起者与动作可在 journal 里对上。
// 仅在 $SERVICE_USER 就是 kore 服务运行身份时安装；不要把 kore-<id> 插件用户
// 或 root 之外的通用账号写进 subject.user。
//
// 最小权限（5 条，缺一条即 NOT_HANDLED；本规则不写无条件 YES，也不写 NO）：
//   1) 只对 org.freedesktop.systemd1.manage-units
//   2) 只对 subject.user === "$SERVICE_USER"
//   3) 只对本机活动会话（subject.local && subject.active）
//   4) 只对 verb ∈ {start, kill, stop, reset-failed}
//   5) 只对 unit ∈ /^kore-root-[a-z][a-z0-9-]*-[a-z][a-z0-9-]*(-[0-9a-f]{8})?\.service$/
polkit.addRule(function(action, subject) {
    var ACTION = "org.freedesktop.systemd1.manage-units";
    var USER = "$SERVICE_USER";
    var UNIT_RE = /^kore-root-[a-z][a-z0-9-]*-[a-z][a-z0-9-]*(-[0-9a-f]{8})?\.service$/;
    var VERBS = ["start", "kill", "stop", "reset-failed"];

    if (action.id !== ACTION) { return polkit.Result.NOT_HANDLED; }
    if (!subject || subject.user !== USER) { return polkit.Result.NOT_HANDLED; }
    if (!subject.local || !subject.active) { return polkit.Result.NOT_HANDLED; }
    var verb = action.lookup("verb");
    if (!verb || VERBS.indexOf(verb) === -1) { return polkit.Result.NOT_HANDLED; }
    var unit = action.lookup("unit");
    if (!unit || !UNIT_RE.test(unit)) { return polkit.Result.NOT_HANDLED; }
    return polkit.Result.YES;
});
RULE
}

# node 功能自检：用假 polkit 沙箱加载规则，断言"该放行的放行、该拒绝的拒绝"。
self_check() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[WARN] 未找到 node，跳过规则功能自检（仅做了 bash 渲染）"
    return 0
  fi
  local tmp
  tmp="$(mktemp -d)"
  render_rule >"$tmp/$RULE_NAME"
  RULE_FILE="$tmp/$RULE_NAME" node <<'JS'
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.env.RULE_FILE, 'utf8');
let rule = null;
const sandbox = { polkit: {
  Result: { YES: 'YES', NO: 'NO', NOT_HANDLED: 'NOT_HANDLED', AUTH_ADMIN: 'AUTH_ADMIN' },
  addRule: (fn) => { if (rule) { throw new Error('规则文件注册了多条 addRule'); } rule = fn; },
  addAdminRule: () => {},
}};
vm.runInNewContext(src, sandbox, { filename: '49-kore.rules' });
if (typeof rule !== 'function') { console.error('[FAIL] 未注册 addRule'); process.exit(1); }

const user = process.env.SERVICE_USER;
const act = (unit, verb) => ({ id: 'org.freedesktop.systemd1.manage-units', lookup: (k) => ({ unit: unit, verb: verb })[k] });
const sub = (name, local, active) => ({ user: name, local: local === undefined ? true : local, active: active === undefined ? true : active });
const cases = [
  ['白名单 unit + start',              'YES',         act('kore-root-firewall-apply-1a2b3c4d.service', 'start'), sub(user)],
  ['白名单 unit 无随机后缀 + stop',     'YES',         act('kore-root-site-reload.service', 'stop'),          sub(user)],
  ['白名单 unit + kill',               'YES',         act('kore-root-container-remove-deadbeef.service', 'kill'), sub(user)],
  ['非 kore-root 前缀（nginx）',         'NOT_HANDLED', act('nginx.service', 'start'),                          sub(user)],
  ['同前缀但危险 verb（disable）',       'NOT_HANDLED', act('kore-root-firewall-apply.service', 'disable'),     sub(user)],
  ['同前缀但危险 verb（mask）',          'NOT_HANDLED', act('kore-root-firewall-apply.service', 'mask'),        sub(user)],
  ['同前缀但非 .service（.timer）',      'NOT_HANDLED', act('kore-root-firewall-apply.timer', 'start'),         sub(user)],
  ['unit 名带注入字符',                 'NOT_HANDLED', act('kore-root-a-b;rm -rf /x.service', 'start'),        sub(user)],
  ['其他用户',                          'NOT_HANDLED', act('kore-root-firewall-apply-1a2b3c4d.service', 'start'), sub('someone-else')],
  ['非本机会话',                        'NOT_HANDLED', act('kore-root-firewall-apply-1a2b3c4d.service', 'start'), sub(user, false, true)],
  ['会话不活动',                        'NOT_HANDLED', act('kore-root-firewall-apply-1a2b3c4d.service', 'start'), sub(user, true, false)],
  ['action 不符（manage-unit-files）',  'NOT_HANDLED', { id: 'org.freedesktop.systemd1.manage-unit-files', lookup: () => 'kore-root-a-b.service' }, sub(user)],
  ['unit 缺失',                         'NOT_HANDLED', { id: 'org.freedesktop.systemd1.manage-units', lookup: () => undefined }, sub(user)],
];
let failed = 0;
for (const [name, want, a, s] of cases) {
  const got = rule(a, s);
  const ok = got === want;
  if (!ok) { failed += 1; }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got=${got} want=${want}`);
}
console.log(`  ---- 功能自检 ${cases.length - failed}/${cases.length} 通过 ----`);
process.exit(failed === 0 ? 0 : 1);
JS
  local rc=$?
  rm -rf "$tmp"
  return $rc
}

case "$MODE" in
  install|dry-run|check)
    echo "polkit 规则安装（kore root-action 免口令）"
    echo "  规则目录: $RULES_DIR（存在性判断：$([ -d "$RULES_DIR" ] && echo yes)）"
    echo "  目标文件: $RULE_PATH"
    echo "  服务用户: $SERVICE_USER (uid=$(id -u "$SERVICE_USER"))"
    echo "  polkitd : $(systemctl is-active polkit 2>/dev/null || echo unknown)"
    ;;
  remove)
    echo "polkit 规则卸载: $RULE_PATH"
    ;;
esac

if [ "$MODE" = "install" ] && [ "$(id -u)" -ne 0 ]; then
  echo
  echo "[NEED-ROOT] 真装需要 root。请以运维身份执行（本脚本不自行提权、不碰 sudo）："
  echo "  sudo bash $(printf '%q' "$0") --user $(printf '%q' "$SERVICE_USER")"
  echo "  非 root 只读校验：bash $(printf '%q' "$0") --check --user $(printf '%q' "$SERVICE_USER")"
  exit 3
fi

if [ "$MODE" = "remove" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[NEED-ROOT] 卸载需要 root：sudo bash $0 --remove" >&2
    exit 3
  fi
  if [ -e "$RULE_PATH" ]; then
    rm -f "$RULE_PATH"
    echo "[OK] 已删除 $RULE_PATH（polkitd 监听规则目录，自动重载；未生效时 systemctl restart polkit）"
  else
    echo "[OK] 规则不存在，无需卸载（幂等）"
  fi
  exit 0
fi

if [ "$MODE" = "dry-run" ] || [ "$MODE" = "check" ]; then
  echo
  echo "----- 规则内容（$RULE_PATH）-----"
  render_rule
  echo "----- 规则内容结束 -----"
  if [ "$MODE" = "check" ]; then
    echo
    echo "语法/功能自检（node + 假 polkit 沙箱；不触达真实 polkitd）："
    export SERVICE_USER
    self_check
  fi
  if [ -e "$RULE_PATH" ]; then
    if diff -q <(render_rule) "$RULE_PATH" >/dev/null 2>&1; then
      echo "[OK] 已安装且内容一致（无需改动）"
    else
      echo "[WARN] 已存在 $RULE_PATH 但内容不同（真装会覆盖；属主/模式 0644 root:root）"
    fi
  else
    echo "[INFO] 尚未安装（$RULE_PATH 不存在）"
  fi
  exit 0
fi

# ---- 真装（root）----
mkdir -p "$RULES_DIR"
tmp="$(mktemp "$RULES_DIR/.$RULE_NAME.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
render_rule >"$tmp"
chmod 0644 "$tmp"
chown root:root "$tmp"
if [ -e "$RULE_PATH" ] && cmp -s "$tmp" "$RULE_PATH"; then
  echo "[OK] 已是最新，无需改动（幂等）: $RULE_PATH"
  exit 0
fi
mv -f "$tmp" "$RULE_PATH"
echo "[OK] 已安装: $RULE_PATH（0644 root:root）"
echo "  验证: systemd-run --uid=0 --pipe true 应不再要求口令"
echo "  撤销: sudo bash $0 --remove"
