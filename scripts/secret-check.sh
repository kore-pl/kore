#!/usr/bin/env bash
# 明文凭据门禁（G-30）——扫描 docs/ 与 .agents/verify/ 中的环境变量式与 JSON 式明文口令。
#
# 背景（2026-11-23 P0）：`.agents/verify/round3-live.md` 曾把 common-mysql 的
# MYSQL_ROOT_PASSWORD 明文写进验收报告并推送公开仓库；web-login-ui / web-settings-ui
# 也写过本机 admin 口令。本脚本只拦「键 = 值」与 `"password":"值"` 两种可机读形态，
# 不追求通用 secret 扫描（通用扫描误报高，会逼人改证据）。
#
# 允许的占位写法：*** / [REDACTED] / $VAR 或 ${VAR} / <placeholder> / ******** / ... / …
# 用法：scripts/secret-check.sh [目录...]
#   无参数时扫仓库内 docs/ 与 .agents/verify/；给目录时只扫给定目录（便于自测）。
# 退出码：0 通过（或目录不存在而 SKIP）；1 命中明文。
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

if [ "$#" -gt 0 ]; then
  DIRS=("$@")
else
  DIRS=("$ROOT/docs" "$ROOT/.agents/verify")
fi

EXIST=0
for d in "${DIRS[@]}"; do
  if [ -d "$d" ]; then
    EXIST=1
  fi
done
if [ "$EXIST" -eq 0 ]; then
  echo "[SKIP] docs/ 与 .agents/verify/ 均不存在，明文凭据扫描跳过"
  exit 0
fi

# 键 = 值：覆盖本机容器凭据与 admin 口令的常见写法。
ENV_RE='(MYSQL_ROOT_PASSWORD|MYSQL_PWD|REDIS_PASSWORD|REDISCLI_AUTH|KORE_MYSQL_PASSWORD|KORE_REDIS_PASSWORD|ADMIN_PASSWORD)[[:space:]]*=[[:space:]]*"?([^"[:space:]`]+)'
# JSON 形态："password": "值" / "secret": "值"（admin_password 单独一条，兼容 YAML）。
JSON_RE='"(password|admin_password|secret|token)"[[:space:]]*:[[:space:]]*"([^"]*)"'
ADMIN_RE='(admin_password)[[:space:]]*[:=][[:space:]]*"?([^"[:space:]`]+)'
SCAN_RE="${ENV_RE}|${JSON_RE}|${ADMIN_RE}"

is_allowed() {
  local v="$1"
  [ -z "$v" ] && return 0
  case "$v" in
    '***' | '[REDACTED]' | '...' | '…') return 0 ;;
    '$'* | '<'*) return 0 ;;
  esac
  # 纯星号（******** 等）
  [[ "$v" =~ ^\*+$ ]] && return 0
  return 1
}

FAIL=0
COUNT=0
while IFS=: read -r file line content; do
  [ -n "${file:-}" ] || continue
  key=""
  val=""
  if [[ "$content" =~ $ENV_RE ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
  elif [[ "$content" =~ $JSON_RE ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
  elif [[ "$content" =~ $ADMIN_RE ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
  else
    continue
  fi
  COUNT=$((COUNT + 1))
  if is_allowed "$val"; then
    continue
  fi
  FAIL=$((FAIL + 1))
  printf '[FAIL] %s:%s %s 疑似明文凭据（值已隐藏）\n' "$file" "$line" "$key"
done < <(grep -rInE --binary-files=without-match -- "$SCAN_RE" "${DIRS[@]}" 2>/dev/null || true)

if [ "$FAIL" -gt 0 ]; then
  printf '\nsecret-check: %d FAIL / %d 处匹配（明文凭据不得入库，改用 *** 或 $VAR）\n' "$FAIL" "$COUNT"
  exit 1
fi

printf 'secret-check: 0 FAIL / %d 处匹配（占位写法均合规）\n' "$COUNT"
exit 0
