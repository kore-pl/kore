#!/usr/bin/env bash
# kore 开源资产门禁（G-26）— 根级开源文件 / MIT LICENSE / CI 入口 / 占位符 / Go 协议头
# 用法: bash scripts/oss-check.sh
# 退出码: 存在 FAIL → 1；仅 WARN → 0（占位符未替换只告警，不阻断）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
WARN=0
FAIL=0

pass()    { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$*"; }
warn()    { WARN=$((WARN + 1)); printf '[WARN] %s\n' "$*"; }
failed()  { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$*"; }
section() { printf '\n-- %s --\n' "$*"; }

# ---------------------------------------------------------------- 1/8 根文件
section "1/8 根级开源文件"
REQUIRED=(LICENSE CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md CHANGELOG.md)
MISSING=()
for f in "${REQUIRED[@]}"; do
  if [ ! -f "$f" ]; then
    MISSING+=("$f")
    failed "缺文件: $f"
  fi
done
if [ "${#MISSING[@]}" -eq 0 ]; then
  pass "根文件齐全: ${REQUIRED[*]}"
fi

# ---------------------------------------------------------------- 2/8 LICENSE 首行
section "2/8 LICENSE（MIT，首行）"
if [ -f LICENSE ]; then
  FIRST="$(sed -n '1p' LICENSE)"
  case "$FIRST" in
    *"MIT License"*) pass "LICENSE 首行含 'MIT License'" ;;
    *) failed "LICENSE 首行不是 MIT License: '$FIRST'" ;;
  esac
else
  failed "LICENSE 不存在，无法校验首行"
fi

# ---------------------------------------------------------------- 3/8 LICENSE 许可条款
section "3/8 LICENSE（MIT，许可条款）"
if [ -f LICENSE ] && grep -qF 'Permission is hereby granted' LICENSE; then
  pass "LICENSE 含标准 MIT 许可句"
else
  failed "LICENSE 缺 'Permission is hereby granted'（不是完整 MIT 模板）"
fi

# ---------------------------------------------------------------- 4/8 CI 存在且含 make check
section "4/8 CI 工作流（存在 + make check）"
CI_FILE=".github/workflows/ci.yml"
if [ ! -f "$CI_FILE" ]; then
  failed "缺 $CI_FILE"
elif grep -q 'make check' "$CI_FILE"; then
  pass "$CI_FILE 存在且调用 make check"
else
  failed "$CI_FILE 未调用 make check（门禁没进 CI）"
fi

# ---------------------------------------------------------------- 5/8 CI 跨平台
section "5/8 CI 跨平台构建（windows / darwin）"
if [ -f "$CI_FILE" ] && grep -q 'GOOS' "$CI_FILE"; then
  pass "$CI_FILE 含 GOOS 交叉构建"
else
  failed "$CI_FILE 缺 GOOS 交叉构建（windows / darwin 未覆盖）"
fi

# ---------------------------------------------------------------- 6/8 CI 文档门禁
section "6/8 CI 文档门禁（make docs-check）"
if [ -f "$CI_FILE" ] && grep -q 'make docs-check' "$CI_FILE"; then
  pass "$CI_FILE 调用 make docs-check"
else
  failed "$CI_FILE 未调用 make docs-check"
fi

# ---------------------------------------------------------------- 7/8 占位符
section "7/8 占位符扫描（<HOLDER> / TODO）"
SCAN_FILES=()
for f in LICENSE CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md; do
  if [ -f "$f" ]; then SCAN_FILES+=("$f"); fi
done
if [ "${#SCAN_FILES[@]}" -eq 0 ]; then
  warn "占位符扫描无对象（根文档缺失）"
else
  HITS="$(grep -nH '<HOLDER>\|TODO' "${SCAN_FILES[@]}" 2>/dev/null || true)"
  if [ -z "$HITS" ]; then
    pass "无占位符（发布前无需替换）"
  else
    pass "占位符扫描完成：命中项以 WARN 列出（不阻断）"
    while IFS= read -r line; do
      if [ -n "$line" ]; then warn "占位符待替换: $line"; fi
    done <<< "$HITS"
  fi
fi

# ---------------------------------------------------------------- 8/8 Go 协议头
section "8/8 Go 协议头（Copyright 必须为 MIT）"
GO_BAD=0
while IFS= read -r f; do
  HEAD10="$(head -n 10 "$f" 2>/dev/null || true)"
  if printf '%s\n' "$HEAD10" | grep -qi 'Copyright'; then
    if ! printf '%s\n' "$HEAD10" | grep -qE 'MIT|SPDX-License-Identifier:[[:space:]]*MIT'; then
      failed "Go 文件头部含 Copyright 但非 MIT: $f"
      GO_BAD=$((GO_BAD + 1))
    fi
  fi
done < <(find . -name '*.go' -not -path './.git/*' | sort)
if [ "$GO_BAD" -eq 0 ]; then
  pass "全部 *.go 头部未发现非 MIT 协议声明"
fi

# ---------------------------------------------------------------- 汇总
printf '\n'
printf 'oss-check: %d pass, %d warn, %d fail\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '结果: 门禁未通过（%d FAIL）\n' "$FAIL"
  exit 1
fi
if [ "$WARN" -gt 0 ]; then
  printf '结果: 门禁通过（%d WARN 不阻断；发布前必须替换占位符）\n' "$WARN"
else
  printf '结果: 门禁通过\n'
fi
exit 0
