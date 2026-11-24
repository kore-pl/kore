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

# 1b) 本仓接线（对本仓同样成立，否则 kore 自己的全仓 -race 会被静默移除）：
#     kore 没有 tests/boundary → 上面 `make race` 恒 [SKIP]，本仓的竞争检查只由
#     `race-full`（第 19 段脚本 race-full-check.sh）提供。三条接线少一条即 FAIL——
#     有目标但 check 不调 = 本地不跑；check 调了但 CI 看不到 = 合入前不跑。
s=0
if ! grep -qE '^race-full:' "$ROOT/Makefile" 2>/dev/null; then
  echo "[FAIL] kore: Makefile 缺 race-full 目标（全仓 -race）"
  s=1
fi
if ! grep -qE 'bash scripts/race-full-check\.sh' "$ROOT/Makefile" 2>/dev/null; then
  echo "[FAIL] kore: check 目标未把全仓 -race 作为独立段调用（scripts/race-full-check.sh）"
  s=1
fi
if ! grep -qE '^[[:space:]]*run: make check' "$ROOT/.github/workflows/ci.yml" 2>/dev/null; then
  echo "[FAIL] kore: ci.yml 未跑 make check（第 19 段没有 CI 执行面）"
  s=1
fi
[ "$s" -ne 0 ] && exit 1
echo "[OK] kore: 全仓 -race 接线完整（race-full 目标 / check 独立段 / ci.yml 跑 make check）"

if [ "${#SIBLINGS[@]}" -eq 0 ]; then
  echo "[N/A] 无兄弟仓（CI 只 checkout kore）：跨仓接线与 -race 真跑由各插件仓 CI 兜底"
  exit 0
fi


# ---------------------------------------------------------------------------
# 4) fd 预算门禁：tests/boundary 里禁止写死**绝对** nofile 预算
#
# 背景：同一类 bug 一晚出现 3 次——`ulimit -n 12` / `ulimit -n 8` / `Setrlimit{Cur:64}`
# 这类绝对预算与「父进程继承了多少 fd」耦合：交互 shell 直跑时被继承 fd 吃掉预算，
# 用例时红时绿；`close_fds=True` 拉起时又耗不尽，把正常行为判成 bug。
# 合法写法只有两种：预算相对自身已开 fd（len(/proc/self/fd)+N、prlimit --nofile=<open+2>），
# 且必须回读内核账本（/proc/*/limits 或 Getrlimit）确认生效。
#
# 规则（先剥注释再匹配，避免注释里写历史写法就误报）：
#   A) FAIL  `ulimit ... -n <数字>`（含 --nofile=<数字>）
#   B) FAIL  `RLIMIT_NOFILE` 同一行出现 `Cur: <数字>` 字面量
#   C) WARN  文件用了 RLIMIT_NOFILE，但没有任何相对预算/回读证据
#
# 误报率：A/B 为静态字面量匹配，剥注释后零误报（字面量预算在这个语义下必错）；
#         已知漏报：多行 `Rlimit{` 字面量（换行写 Cur: 64）——故意不做跨行匹配，
#         否则会把 RLIMIT_FSIZE 的 Cur 数字误算到 NOFILE 头上（monitor 就是这种结构）。
# ---------------------------------------------------------------------------
fd_budget_scan() {
  local label="$1"; shift
  python3 - "$label" "$@" <<'PY'
import os, re, sys

label = sys.argv[1]
dirs = [d for d in sys.argv[2:] if os.path.isdir(d)]

UlimitLiteral = re.compile(r'ulimit[^\n]*?\s-[A-Za-z]*n\s+\d+')
UlimitNofile = re.compile(r'ulimit[^\n]*?--nofile[= ]\s*\d+')
# prlimit 也可能被写成绝对预算：只拦字面量，`--nofile=<表达式>` 不拦。
PrlimitLiteral = re.compile(r'prlimit[^\n]*?--nofile\s*=\s*\d+')
CurLiteral = re.compile(r'Cur:\s*\d+')
RelativeEvidence = ('/proc/self/fd', '/proc/%d/fd', 'prlimit', 'Getrlimit')

def strip_comments(text, path):
    if path.endswith('.go'):
        text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
        return '\n'.join(line.split('//', 1)[0] for line in text.splitlines())
    return '\n'.join(line.split('#', 1)[0] for line in text.splitlines())

fails, warns, scanned = [], [], 0
for root in dirs:
    for cur, _dirs, files in os.walk(root):
        for name in sorted(files):
            if not name.endswith(('.go', '.sh', '.py', '.bats')):
                continue
            path = os.path.join(cur, name)
            try:
                raw = open(path, encoding='utf-8', errors='replace').read()
            except OSError:
                continue
            scanned += 1
            body = strip_comments(raw, path)
            for lineno, line in enumerate(body.splitlines(), 1):
                if UlimitLiteral.search(line) or UlimitNofile.search(line) or PrlimitLiteral.search(line):
                    fails.append((path, lineno, 'ulimit/prlimit 字面量绝对预算', line.strip()))
                if 'RLIMIT_NOFILE' in line and CurLiteral.search(line):
                    fails.append((path, lineno, 'RLIMIT_NOFILE 字面量 Cur', line.strip()))
            if 'RLIMIT_NOFILE' in body and not any(marker in body for marker in RelativeEvidence):
                warns.append((path, 0, 'RLIMIT_NOFILE 无相对预算/回读证据', ''))

for path, lineno, why, snippet in fails:
    print(f"[FAIL] {label}: {path}:{lineno} {why} → {snippet[:130]}")
for path, _lineno, why, _snippet in warns:
    print(f"[WARN] {label}: {path} {why}（应有 len(/proc/self/fd)+N 与 Getrlimit//proc limits 回读）")

print(f"[INFO] {label}: fd 预算扫描 {scanned} 个文件 · 绝对预算 {len(fails)} 命中 · 待查 {len(warns)}")
sys.exit(1 if fails else 0)
PY
}

if [ "${1:-}" = "--fd-budget-self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/bad" "$tmp/good"
  cat > "$tmp/bad/abs_test.go" <<'EOF'
package boundary
func t0() { _ = exec.Command("prlimit", "--pid", "1", "--nofile=12:") }
func t1() { script := `ulimit -n 12; exec bin` }
func t2() { _ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: 64, Max: 64}) }
EOF
  cat > "$tmp/good/rel_test.go" <<'EOF'
package boundary
// 历史写法 `ulimit -n 8` 已废弃，仅注释里出现不应误报。
func t3() { ents, _ := os.ReadDir("/proc/self/fd"); _ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{Cur: uint64(len(ents)) + 8, Max: orig.Max}) }
EOF
  rc=0
  if fd_budget_scan "self-test/反例" "$tmp/bad" >/tmp/fd-budget-bad.log 2>&1; then rc=1; fi
  if ! grep -q "绝对预算 3 命中" /tmp/fd-budget-bad.log; then rc=1; fi
  if ! fd_budget_scan "self-test/正例" "$tmp/good" >/tmp/fd-budget-good.log 2>&1; then rc=1; fi
  if ! grep -q "绝对预算 0 命中" /tmp/fd-budget-good.log; then rc=1; fi
  if [ "$rc" -eq 0 ]; then
    echo "[OK] fd 预算门禁自证：反例 3 命中（ulimit / prlimit 字面量 + Rlimit{Cur:字面量}），正例 0 命中（含注释里的历史写法）"
  else
    echo "[FAIL] fd 预算门禁自证未通过"; cat /tmp/fd-budget-bad.log /tmp/fd-budget-good.log
  fi
  rm -f /tmp/fd-budget-bad.log /tmp/fd-budget-good.log
  exit "$rc"
fi

FAIL=0
CHECKED=0
RACED=0

# 4) fd 预算门禁先跑静态面：写死绝对 nofile 预算的仓直接阻断，不必等 -race 变红才发现。
BOUNDARY_DIRS=()
for repo in "${SIBLINGS[@]}"; do
  [ -d "$repo/tests/boundary" ] && BOUNDARY_DIRS+=("$repo/tests/boundary")
done
if [ "${#BOUNDARY_DIRS[@]}" -gt 0 ]; then
  if ! fd_budget_scan "跨仓 boundary" "${BOUNDARY_DIRS[@]}"; then
    echo "[FAIL] fd 预算门禁：存在写死绝对 nofile 预算的边界用例（改为相对自身 fd + 回读 + 正控）"
    FAIL=1
  fi
fi

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
