#!/usr/bin/env bash
# kore `make check` 第 18 段：race 门禁（跨仓，阻断级）
#
# 背景：2026-11-24 前，kore 与 24 个插件仓的 Makefile / CI 都是 `go test ./...`，没有
# `-race`。今晚补的并发边界用例全部声称"必须过 -race"，但 CI 从不以 -race 跑 ——
# 等于写了并发断言却从没验过数据竞争，下一次改动引入竞争不会被发现。
#
# 本段做三件事（都不是文本核对）：
#   1. 本仓：`make race`（race 目标只认 ./tests/boundary/；本仓当前没有 → SKIP）
#   2. 兄弟仓静态接线：有 tests/boundary/*_test.go 的仓，Makefile 必须有 race 目标、
#      check 目标必须调用 race、CI 必须显式 `run: make race`（少了哪条都 FAIL）
#   3. 兄弟仓真跑：对每个有边界用例的仓执行 `make -C <repo> race` —— -race 真编译真执行；
#      任何一个 FAIL / 超时 / 编译不过，本段即阻断
#
# 无兄弟仓（GitHub CI 只 checkout kore）→ [N/A] 不阻断；接线缺失 → [FAIL] 阻断。
# 不联网、不调用 git、不写状态。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIBLINGS=()
shopt -s nullglob
for d in "$ROOT"/../kore-plugin-*; do
  [ -d "$d" ] && SIBLINGS+=("$d")
done
shopt -u nullglob

echo "[INFO] race 门禁：-race 只跑 ./tests/boundary/（并发断言面），不做全仓 -race"

# 1) 本仓
if [ -f "$ROOT/Makefile" ] && grep -qE '^race:' "$ROOT/Makefile"; then
  if ! ( cd "$ROOT" && make --no-print-directory race ); then
    echo "[FAIL] kore: make race 未通过"
    exit 1
  fi
else
  echo "[FAIL] kore: Makefile 缺 race 目标"
  exit 1
fi

if [ "${#SIBLINGS[@]}" -eq 0 ]; then
  echo "[N/A] 无兄弟仓（CI 只 checkout kore）：跨仓接线与 -race 真跑由各插件仓 CI 兜底"
  exit 0
fi

FAIL=0
CHECKED=0
RACED=0

for repo in "${SIBLINGS[@]}"; do
  name="$(basename "$repo")"
  boundary_count=0
  if [ -d "$repo/tests/boundary" ]; then
    boundary_count="$(find "$repo/tests/boundary" -maxdepth 1 -name '*_test.go' | wc -l | tr -d ' ')"
  fi
  if [ "$boundary_count" = "0" ]; then
    echo "[SKIP] $name: 无 tests/boundary/*_test.go（race 目标存在即自动生效）"
    continue
  fi
  CHECKED=$((CHECKED + 1))
  s=0
  if ! grep -qE '^race:' "$repo/Makefile" 2>/dev/null; then
    echo "[FAIL] $name: Makefile 缺 race 目标（跑 bash scripts/race-gate-sync.sh 渲染）"
    s=1
  fi
  if ! grep -qE '^[[:space:]]*@\$\(MAKE\) --no-print-directory race[[:space:]]*$' "$repo/Makefile" 2>/dev/null; then
    echo "[FAIL] $name: check 目标未把 race 作为独立段调用"
    s=1
  fi
  if ! grep -qE '^[[:space:]]*(- name:.*race|run: make race)' "$repo/.github/workflows/ci.yml" 2>/dev/null; then
    echo "[FAIL] $name: .github/workflows/ci.yml 未显式跑 make race（CI 里看不到 -race 等于没跑）"
    s=1
  fi
  [ "$s" -ne 0 ] && { FAIL=1; continue; }

  echo "[RUN ] $name: make race（$boundary_count 个边界测试文件，-race 真跑）"
  if ( cd "$repo" && make --no-print-directory race ); then
    RACED=$((RACED + 1))
  else
    echo "[FAIL] $name: make race 未通过（数据竞争 / 编译 / 超时，见上方原文）"
    FAIL=1
  fi
done

echo ""
echo "[INFO] race 门禁：有边界用例 $CHECKED 仓 · -race 真跑通过 $RACED 仓"
if [ "$FAIL" -ne 0 ]; then
  echo "[FAIL] race 门禁未通过"
  exit 1
fi
echo "[OK] race 门禁通过（接线完整 + -race 真跑全绿）"
