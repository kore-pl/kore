#!/usr/bin/env bash
# 索引签名公钥「单一真源」门禁（ADR-0025 §5）。
#
# 两端必须逐字一致：内核编译期常量 verify.go:IndexPublicKeyHex ↔ 索引仓验签脚本
# validate-index.sh:PUB_HEX。不一致 = 签出的索引内核验不过（商店全 401），必须在提交前红。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KORE_PLUGINS_DIR="${KORE_PLUGINS_DIR:-$ROOT/../kore-plugins}"
VERIFY="$ROOT/internal/core/market/verify.go"
VALIDATE="$KORE_PLUGINS_DIR/scripts/validate-index.sh"

fail() { echo "[FAIL] $*" >&2; exit 1; }

[ -f "$VERIFY" ] || fail "缺少 $VERIFY"
[ -f "$VALIDATE" ] || fail "缺少 $VALIDATE（可用 KORE_PLUGINS_DIR 指向索引仓）"

# 抽取「文件:行:公钥」；只认 64 位小写 hex，找不到即视为门禁失败。
extract() {
  local file="$1" pattern="$2"
  grep -nE "$pattern" "$file" | head -1 | while IFS=: read -r line rest; do
    hex="$(printf '%s' "$rest" | grep -oE '[0-9a-f]{64}' | head -1)"
    [ -n "$hex" ] && echo "$file:$line:$hex"
  done
}

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
