#!/usr/bin/env bash
# 明文凭据门禁（G-30）——扫描 docs/ 与 .agents/verify/ 中的环境变量式与 JSON 式明文口令。
#
# 背景（2026-11-23 P0）：`.agents/verify/round3-live.md` 曾把 common-mysql 的
# MYSQL_ROOT_PASSWORD 明文写进验收报告并推送公开仓库；web-login-ui / web-settings-ui
# 也写过本机 admin 口令。本脚本只拦「键 = 值」与 `"password":"值"` 两种可机读形态，
# 不追求通用 secret 扫描（通用扫描误报高，会逼人改证据）。
#
# 允许的占位写法：*** / [REDACTED] / $VAR 或 ${VAR} / <placeholder> / ******** / ... / …
# 证据文档里的「键名作命令/正则模式」豁免（如 grep -nE 'ADMIN_PASSWORD=...|...'）：
#   整行须同时含 grep 与 -E，且匹配值本身是正则模式片段（含 | \ [ ] ( ) <…> + ? …），
#   才判为模式片段 → WARN 不 FAIL；真实赋值凭据（ADMIN_PASSWORD=hunter2）绝不豁免。
# 用法：scripts/secret-check.sh [目录或文件...] [--self-test]
#   无参数时扫仓库内 docs/ 与 .agents/verify/；给路径时只扫给定路径（便于自测）。
# 退出码：0 通过（或路径不存在而 SKIP）；1 命中明文。
set -uo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# --self-test：临时目录造正反例夹具，退出即删，不读仓库文档。
if [ "${1:-}" = "--self-test" ]; then
  ST=$(mktemp -d)
  trap 'rm -rf "$ST"' EXIT
  PASS_N=0
  FAIL_N=0
  expect() { # $1=期望退出码 $2=文件相对名 $3=内容 $4=说明
    local want="$1" rel="$2" content="$3" what="$4" out rc
    local case_dir="$ST/$(printf '%s' "$rel" | tr '/.' '__')"
    mkdir -p "$case_dir"
    printf '%s\n' "$content" > "$case_dir/case.md"
    out=$(bash "$0" "$case_dir" 2>&1); rc=$?
    if [ "$rc" = "$want" ]; then
      printf '[PASS] self-test %s（exit=%s）\n' "$what" "$rc"
      PASS_N=$((PASS_N + 1))
    else
      printf '[FAIL] self-test %s（期望 exit=%s，实际 exit=%s）\n' "$what" "$want" "$rc"
      printf '%s\n' "$out"
      FAIL_N=$((FAIL_N + 1))
    fi
  }
  # 正例：真实赋值凭据必须 FAIL。
  expect 1 "real-env.md" 'ADMIN_PASSWORD=hunter2' "真实 ADMIN_PASSWORD 赋值 → FAIL"
  expect 1 "real-admin.md" 'admin_password: s3cr3t' "真实 admin_password 赋值 → FAIL"
  # 反例：grep -E 命令里的交替正则模式 → 不 FAIL（WARN）。
  expect 0 "grep-pattern.md" "grep -nE 'ADMIN_PASSWORD=\\|MYSQL_PWD=' file.md" "grep -E 交替正则模式 → 不 FAIL"
  expect 0 "grep-bracket.md" "grep -nE 'ADMIN_PASSWORD=[a-z]+' file.md" "grep -E 字符类正则模式 → 不 FAIL"
  # 边界：值带正则元字符但无 grep -E 命令上下文 → 仍按凭据 FAIL（豁免不得泛化）。
  expect 1 "no-cmd-context.md" 'ADMIN_PASSWORD=a|b' "无命令上下文的元字符赋值 → FAIL"
  # 边界：占位写法（<pattern>/***）任何上下文都不 FAIL。
  expect 0 "placeholder.md" 'ADMIN_PASSWORD=<pattern>' "<pattern> 占位 → 不 FAIL"
  if [ "$FAIL_N" -gt 0 ]; then
    printf 'secret-check self-test: %d FAIL\n' "$FAIL_N"
    exit 1
  fi
  printf 'secret-check self-test: %d pass, 0 fail\n' "$PASS_N"
  exit 0
fi

DIRS=("$@")
if [ "${#DIRS[@]}" -eq 0 ]; then
  DIRS=("$ROOT/docs" "$ROOT/.agents/verify")
fi

EXIST=0
for d in "${DIRS[@]}"; do
  if [ -e "$d" ]; then
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

# 证据文档里的 grep / -E 正则模式片段（如 ADMIN_PASSWORD=\|MYSQL_PWD=、[a-z]+）不是凭据。
# 判据要窄：必须有命令上下文（同一行 grep 且 -E）且值本身是模式片段，才豁免为 WARN。
is_pattern_context() {
  local line="$1" val="$2"
  [[ "$line" == *grep* ]] || return 1
  # -E 可能单独出现或与 -n 合并为 -nE / -EnE 等。
  [[ "$line" == *"-E"* || "$line" == *"-nE"* || "$line" == *"-En"* ]] || return 1
  case "$val" in
    *'|'*|*'\'*|*'['*|*']'*|*'('*|*')'*|*'<'*'>'*|*'+'*|*'?'*|*'…'*) return 0 ;;
  esac
  return 1
}

FAIL=0
COUNT=0
WARN=0
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
  if is_pattern_context "$content" "$val"; then
    printf '[WARN] %s:%s %s 命中键名但为 grep 正则模式片段（非凭据，不阻断）\n' "$file" "$line" "$key"
    WARN=$((WARN + 1))
    continue
  fi
  FAIL=$((FAIL + 1))
  printf '[FAIL] %s:%s %s 疑似明文凭据（值已隐藏）\n' "$file" "$line" "$key"
done < <(grep -rInE --binary-files=without-match -- "$SCAN_RE" "${DIRS[@]}" 2>/dev/null || true)

if [ "$FAIL" -gt 0 ]; then
  printf '\nsecret-check: %d FAIL / %d 处匹配（明文凭据不得入库，改用 *** 或 $VAR）\n' "$FAIL" "$COUNT"
  exit 1
fi

printf 'secret-check: 0 FAIL / %d 处匹配（占位写法 / grep 正则模式均合规，%d WARN）\n' "$COUNT" "$WARN"
exit 0
