#!/usr/bin/env bash
# kore `make check` 第 19 段：全仓 `-race` 门禁（本仓，阻断级，2026-11-24 接入）
#
# 为什么第 18 段盖不住这件事：
#   第 18 段 `scripts/race-gate-check.sh` 的 -race 只跑 ./tests/boundary/，而 kore 本仓
#   还没有 tests/boundary/ → 本仓 `make race` 恒 [SKIP]。等于 **kore 自己的代码在 race
#   detector 面前零覆盖**。2026-11-24 实测证明这不是理论风险：`bd3ac83` 在 cmd/kored
#   修掉两处真实数据竞争（结果审计先于终态发布 / launch 返回锁内快照），当时
#   `go test ./...` 全绿、断言全过，**只有 -race 能抓**。没有这一段，同类竞争下次照样合入。
#
# 判据（真跑，不是文本核对）：
#   GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout 600s ./...
#   - exit != 0            → [FAIL] 阻断（数据竞争 / 测试失败 / 编译失败，一律阻断）
#   - 输出含 WARNING: DATA RACE → 单独打红后阻断（便于在长输出里定位）
#   - -race 需要 cgo：缺 C 编译器 → [FAIL] 并给出事实，**不静默降级成"跳过 -race"**
#   - 无 go.mod（M0 骨架态） → [SKIP] 退出 0，不假装通过
#
# 固定面而不是"改动包"：判据必须是「immutable 面必绿」，不依赖 diff 推断出的闭包
# （算错即静默放行，见 LOG/DECISIONS.md 2026-11-24 裁决 C 被否的理由）。
# 包级并行：go test 默认并行跑各包，墙钟时间 ≈ 最慢的那个包（实测 cmd/kored 51.7s
# 主导，全部 internal/* 并行后只多 0.47s），所以分段跑 internal 省不下时间。
# 不联网、不调用 git、不写状态。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TIMEOUT="${RACE_TIMEOUT:-600s}"

if [ ! -f go.mod ]; then
  echo "[SKIP] 无 go.mod（骨架态）：全仓 -race 无目标，M1 自动生效"
  exit 0
fi

# -race 需要 cgo + C 编译器。缺的时候必须 FAIL：让它"跳过"等于把数据竞争检查
# 静默降级成不跑，这是本段存在的唯一意义。
if ! command -v "$(CGO_ENABLED=1 go env CC 2>/dev/null || echo cc)" >/dev/null 2>&1; then
  echo "[FAIL] 缺 C 编译器（-race 需要 cgo，本机 $(CGO_ENABLED=1 go env CC 2>/dev/null || echo cc) 不可用）"
  echo "       安装 gcc/clang 后重跑；不允许跳过本段——跳过即等于不检查数据竞争"
  exit 1
fi
if [ "$(CGO_ENABLED=1 go env CGO_ENABLED 2>/dev/null || echo 0)" != "1" ]; then
  echo "[FAIL] CGO_ENABLED 无法置为 1（-race 依赖 cgo），不静默降级"
  exit 1
fi

# web/embed.go 用 //go:embed 嵌 web/dist：干净树上没有它 → 所有依赖 web 的包 setup failed，
# 报错与数据竞争无关，会变成"原因不对的 FAIL"。web-dist 只做本地文件拷贝（无 npm / 无网络），
# 缺了就补一次，保证本段在任何树上都只因真实测试结果红绿。
if [ ! -f web/dist/app.js ]; then
  echo "[INFO] web/dist 缺失（//go:embed 依赖）→ 先跑 make web-dist（纯本地拷贝）"
  if ! make --no-print-directory web-dist >/dev/null 2>&1 || [ ! -f web/dist/app.js ]; then
    echo "[FAIL] web/dist 生成失败：无法编译 embed 包，本段不能给出有效结论（不允许当作跳过）"
    exit 1
  fi
fi

OUT="$(mktemp -t kore-race-full.XXXXXX.log)"
trap 'rm -f "$OUT"' EXIT

echo "[RUN ] 全仓 -race: GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout $TIMEOUT ./..."
start=$SECONDS
rc=0
GOWORK=off CGO_ENABLED=1 go test -race -count=1 -timeout "$TIMEOUT" ./... >"$OUT" 2>&1 || rc=$?
elapsed=$((SECONDS - start))

# 失败时全量输出（竞争报告就在里面，不能被截断）；成功时只留每包 ok 行 + 汇总。
if [ "$rc" -ne 0 ]; then
  grep -q 'WARNING: DATA RACE' "$OUT" && echo "[FAIL] 检出数据竞争（WARNING: DATA RACE）："
  cat "$OUT"
  echo "[FAIL] 全仓 -race 未通过（exit=$rc，${elapsed}s）—— 数据竞争 / 测试失败 / 编译失败均阻断"
  exit 1
fi

pkgs="$(grep -c '^ok[[:space:]]' "$OUT" || true)"
echo "$OUT" | sed -n 's/^\(ok[[:space:]]\+[^[:space:]]\+\).*$/\1/p' | head -40
[ "${pkgs:-0}" -gt 40 ] && echo "        ……（共 $pkgs 个包，仅列前 40）"
grep -q 'WARNING: DATA RACE' "$OUT" && { cat "$OUT"; echo "[FAIL] 输出含 DATA RACE"; exit 1; }
echo "[OK] 全仓 -race 通过（$pkgs 个包，${elapsed}s，零 DATA RACE）"
exit 0
