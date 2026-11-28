#!/usr/bin/env bash
# 索引签名公钥「单一真源」门禁（ADR-0025 §5）。
#
# 两端必须逐字一致：内核编译期常量 verify.go:IndexPublicKeyHex ↔ 索引仓验签脚本
# validate-index.sh:PUB_HEX。不一致 = 签出的索引内核验不过（商店全 401），必须在提交前红。
#
# 独立 clone 未检出 kore-plugins 时，validate-index.sh 不存在 → SKIP exit 0
# （与 Makefile market-check「kore-plugins 缺失 SKIP」口径一致，不阻断独立 clone）。
# 安全判据不放宽：文件存在但两端公钥不一致仍 FAIL。
# 用法: scripts/pubkey-sync-check.sh [--self-test]
#   --self-test 自造夹具跑三场景正反用例（正常一致 / 缺失 SKIP / 不一致 FAIL），退出即删。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KORE_PLUGINS_DIR="${KORE_PLUGINS_DIR:-$ROOT/../kore-plugins}"
VERIFY="${VERIFY:-$ROOT/internal/core/market/verify.go}"
VALIDATE="${VALIDATE:-$KORE_PLUGINS_DIR/scripts/validate-index.sh}"

fail() { echo "[FAIL] $*" >&2; exit 1; }

# 抽取「文件:行:公钥」；只认 64 位小写 hex，找不到即视为门禁失败。
extract() {
  local file="$1" pattern="$2"
  grep -nE "$pattern" "$file" | head -1 | while IFS=: read -r line rest; do
    hex="$(printf '%s' "$rest" | grep -oE '[0-9a-f]{64}' | head -1)"
    [ -n "$hex" ] && echo "$file:$line:$hex"
  done
}

run_check() {
  [ -f "$VERIFY" ] || fail "缺少 $VERIFY"

  # 独立 clone 缺索引仓 = SKIP（不阻断）；文件在但公钥不一致 = FAIL（下面的硬判据）。
  if [ ! -f "$VALIDATE" ]; then
    echo "[SKIP] 缺少 $VALIDATE（未检出 kore-plugins 索引仓）：索引公钥一致性跳过，不阻断独立 clone（可用 KORE_PLUGINS_DIR 指向索引仓）"
    return 0
  fi

  local A B HA HB
  A="$(extract "$VERIFY" 'IndexPublicKeyHex[[:space:]]*=[[:space:]]*"[0-9a-f]{64}"')"
  B="$(extract "$VALIDATE" '^PUB_HEX="[0-9a-f]{64}"')"
  [ -n "$A" ] || fail "在 $VERIFY 找不到 64 hex 的 IndexPublicKeyHex"
  [ -n "$B" ] || fail "在 $VALIDATE 找不到 64 hex 的 PUB_HEX"

  HA="${A##*:}"; HB="${B##*:}"
  if [ "$HA" != "$HB" ]; then
    echo "[FAIL] 两端索引公钥不一致（ADR-0025：只允许一个真源）：" >&2
    echo "       内核  $A" >&2
    echo "       索引  $B" >&2
    exit 1
  fi
  echo "[OK] 两端公钥一致：$A"
  echo "[OK] 索引仓验签脚本：$B"
}

# --self-test：三场景正反例（正常一致 / 缺失 SKIP / 不一致 FAIL）。
if [ "${1:-}" = "--self-test" ]; then
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  KA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  KB="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  printf 'const IndexPublicKeyHex = "%s"\n' "$KA" > "$T/verify-ok.go"
  printf 'const IndexPublicKeyHex = "%s"\n' "$KA" > "$T/verify-bad.go"
  printf 'PUB_HEX="%s"\n' "$KA" > "$T/validate-ok.sh"
  printf 'PUB_HEX="%s"\n' "$KB" > "$T/validate-bad.sh"
  st_fail=0
  check() { # $1=期望退出码 $2=期望输出关键字 $3=说明 $4=VERIFY $5=VALIDATE
    local want="$1" kw="$2" what="$3" vf="$4" vf2="$5" out rc
    out=$(VERIFY="$vf" VALIDATE="$vf2" run_check 2>&1); rc=$?
    if [ "$rc" = "$want" ] && printf '%s' "$out" | grep -qF "$kw"; then
      printf '[PASS] self-test %s（exit=%s，含 %s）\n' "$what" "$rc" "$kw"
    else
      printf '[FAIL] self-test %s（期望 exit=%s/含 %s，实际 exit=%s/%s）\n' \
        "$what" "$want" "$kw" "$rc" "$out"
      st_fail=$((st_fail + 1))
    fi
  }
  check 0 "[OK] 两端公钥一致" "正常一致 → OK exit0" \
    "$T/verify-ok.go" "$T/validate-ok.sh"
  check 0 "[SKIP] 缺少" "缺 validate-index.sh → SKIP exit0" \
    "$T/verify-ok.go" "$T/no-such-dir/validate-index.sh"
  check 1 "[FAIL] 两端索引公钥不一致" "文件存在但公钥不一致 → FAIL exit1" \
    "$T/verify-bad.go" "$T/validate-bad.sh"
  if [ "$st_fail" -gt 0 ]; then
    printf 'pubkey-sync-check self-test: %d FAIL\n' "$st_fail"
    exit 1
  fi
  printf 'pubkey-sync-check self-test: 3 pass, 0 fail\n'
  exit 0
fi

run_check
