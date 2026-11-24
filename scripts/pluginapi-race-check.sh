#!/usr/bin/env bash
# kore `make check` 第 21 段：嵌套 module `pkg/pluginapi` 的全量 `-race` 门禁（阻断级，2026-11-24 接入）
#
# 防的事故：`pkg/pluginapi` 是**嵌套 module**（自带 `pkg/pluginapi/go.mod`，根 go.mod 用
# `replace github.com/pengtang1024/kore/pkg/pluginapi => ./pkg/pluginapi` 指向它）。Go 的
# `./...` 只匹配**当前 module 内**的包，**不会**跨 module 遍历——实测（go1.26.8，0c47c2a）：
#   root `go list ./...`           → 18 个包，0 个 pluginapi
#   root `go test ./... | grep pluginapi` → 0 行
#   `cd pkg/pluginapi && go test ./...` → 2 个包（pluginapi + pluginapitest）
# 所以第 17 段（`go build ./...`）与第 19 段（全仓 `-race ./...`）**都不覆盖它**：
# nginxconf 解析器（32 条禁用指令 + 4 个族 + 23 条叶子规则）、file_write 协议校验、
# `ValidateRootAction` / `ValidateRootAppendedArgv`（ADR-0022 三级形状）、
# `RootCommandPolicies`（13 条受控命令）的 12 个测试文件在 `make check` 里零执行。
#
# 判据（真跑，不是文本核对）：
#   cd pkg/pluginapi && GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout 600s ./...
#   - exit != 0               → [FAIL] 阻断（数据竞争 / 测试失败 / 编译失败，一律阻断）
#   - 输出含 WARNING: DATA RACE → 单独打红后阻断（便于在长输出里定位）
#   - 一个包都没跑到           → [FAIL]（`./...` 匹配为空也是假绿，不允许当通过）
#   - -race 需要 cgo：缺 C 编译器 / CGO 无法置 1 → [FAIL]，**不静默降级成跳过**
#   - pkg/pluginapi/go.mod 不存在 → [SKIP] 退出 0（嵌套 module 被移除的骨架态）
#
# 口径与第 19 段一致：固定面 `./...`（不按 diff 推断改动包），包级并行，不联网、
# 不调用 git、不写状态。实测耗时约 1.3s（1.6s 冷 / 1.3s 热），相对 163s 的整段门禁可忽略。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="pkg/pluginapi"
cd "$ROOT"

TIMEOUT="${PLUGINAPI_RACE_TIMEOUT:-600s}"

if [ ! -f "$MODULE/go.mod" ]; then
  echo "[SKIP] 无 $MODULE/go.mod（嵌套 module 不存在）：第 21 段无目标"
  exit 0
fi

# -race 需要 cgo + C 编译器。缺的时候必须 FAIL：让它"跳过"等于把嵌套 module 的
# 数据竞争检查静默降级成不跑，而本段存在的唯一意义就是不让这段代码没人看。
if ! command -v "$(CGO_ENABLED=1 go env CC 2>/dev/null || echo cc)" >/dev/null 2>&1; then
  echo "[FAIL] 缺 C 编译器（-race 需要 cgo，本机 $(CGO_ENABLED=1 go env CC 2>/dev/null || echo cc) 不可用）"
  echo "       安装 gcc/clang 后重跑；不允许跳过本段——跳过即等于不检查数据竞争"
  exit 1
fi
if [ "$(CGO_ENABLED=1 go env CGO_ENABLED 2>/dev/null || echo 0)" != "1" ]; then
  echo "[FAIL] CGO_ENABLED 无法置为 1（-race 依赖 cgo），不静默降级"
  exit 1
fi

OUT="$(mktemp -t kore-pluginapi-race.XXXXXX.log)"
trap 'rm -f "$OUT"' EXIT

echo "[INFO] 根 module 的 ./... 不遍历嵌套 module：本段显式进入 $MODULE（自带 go.mod）"
echo "[RUN ] $MODULE: GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout $TIMEOUT ./..."
start=$SECONDS
rc=0
( cd "$MODULE" && GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout "$TIMEOUT" ./... ) >"$OUT" 2>&1 || rc=$?
elapsed=$((SECONDS - start))

if [ "$rc" -ne 0 ]; then
  grep -q 'WARNING: DATA RACE' "$OUT" && echo "[FAIL] 检出数据竞争（WARNING: DATA RACE）："
  cat "$OUT"
  echo "[FAIL] $MODULE 全量 -race 未通过（exit=$rc，${elapsed}s）—— 数据竞争 / 测试失败 / 编译失败均阻断"
  exit 1
fi

# 跑到的包数（ok = 有测试且通过；? = 无测试文件）。一个都没跑到说明 ./... 匹配为空，
# 这时"[OK]"是假绿——必须红，而不是拿退出码 0 当通过。
pkgs="$(grep -c -E '^(ok|\?)[[:space:]]' "$OUT" || true)"
pkgs="${pkgs:-0}"
if [ "$pkgs" -lt 1 ]; then
  cat "$OUT"
  echo "[FAIL] $MODULE: go test ./... 没有跑到任何包（固定面为空 = 假绿），本段不能给出有效结论"
  exit 1
fi

echo "$OUT" | sed -n 's/^\(ok[[:space:]]\+[^[:space:]]\+\).*$/\1/p' | head -20
grep -q 'WARNING: DATA RACE' "$OUT" && { cat "$OUT"; echo "[FAIL] 输出含 DATA RACE"; exit 1; }
echo "[OK] $MODULE 全量 -race 通过（$pkgs 个包，${elapsed}s，零 DATA RACE）"
exit 0
