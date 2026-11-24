#!/usr/bin/env bash
# kore 预设一致性门禁（G-18）
#
# 用法: bash scripts/presets-check.sh [preset.json ...]
#   无参数 = 扫描 ../kore-plugins/presets/*.json 并对 ../kore-plugins/index/plugins.json 解析
#   --self-test 只跑版本区间解析器的正反用例（不读仓库文件）
#
# 判据（G-18 原文，不放宽）：
#   1) preset.plugins[].id 必须能在索引 index/plugins.json 找到
#   2) preset.plugins[].version 区间必须被索引里的实际版本满足。支持写法：
#        精确 x.y.z ｜ ^x.y.z ｜ ~x.y.z ｜ 比较器集合（>=x.y.z <a.b.c、>、<=、=）
#      其余写法（*、1.x、latest、>=1.0、|| 等）= FAIL，不静默跳过
#   3) 资源合计：常驻（索引 lifecycle=resident 且 desired=enabled）RSS 合计
#        ≤48 MiB 红线（超即 FAIL）/ ≤24 MiB 目标（超即 WARN）
#        同时常驻 ≤3（G-03 红线）；单插件包体积 ≤25 MiB（G-03 单二进制红线）
#      常驻内存取自 ../kore-plugin-<id>/info.json 的 resources.memory_mb
#      （索引无该字段；取不到即 FAIL —— 无法核对预算不允许算过）
#   4) 失败指名到「preset + id + 区间 + 原因」
#   5) 深度等级一致性（G-20）：索引 index/plugins.json 的 depth_level 必须等于
#      ../kore-plugin-<id>/info.json 的 depth_level。分类三档，不混判：
#        · 不一致且 id 在 scripts/depth-level-pending.txt（已知待裁决清单）→ WARN，不阻断
#        · 不一致且不在清单（新增不一致）→ FAIL，阻断
#        · 清单条目已一致 / 索引已无此 id（陈旧条目）→ WARN，提示移除
#      判据不放宽：清单是「存量豁免登记」，不是放行名单——新仓新错一律 FAIL。
#   6) out_of_box × depth_level（G-20 明文：basic 插件不得被预设标为「开箱可用」）：
#      out_of_box=true 的预设不得引用索引 depth_level≠production 的插件（不看 desired）。
#   7) 生产级声明内容（G-20 判据①②，2026-11-24 接入）：声明 production 的插件必须**真的**
#      满足两条判据，而不只是索引与 info.json 自洽：
#        判据② 故障注入：<插件仓>/tests/fault/ 存在，且含 `func Test` 的 *_test.go（静态核对；
#                实跑由各仓 CI / make check 负责，本门禁不重复跑 go test）
#        判据① 边界用例：<插件仓>/tests/boundary/ 存在 + 含 `func Test` 的 *_test.go
#                + 并发证据 ≥1（`t.Parallel` / `go func` / `sync.`）
#                + 四类代表性覆盖各 ≥1（异常输入 / 并发 / 权限 / 资源耗尽；取文件名 + 注释行）
#                + **真跑**：静态核对通过后执行 `GOWORK=off go test ./tests/boundary/ -count=1`
#                  （单仓上限 BOUNDARY_TEST_TIMEOUT=120s，超时杀进程组）：PASS 才算满足；
#                  FAIL / 编译失败 / 超时 → 判据①不满足（清单内 WARN / 清单外 FAIL）。
#                  静态已不满足的仓不跑——结论已定，跑了也不改变，这是性能上的省。
#      分层上线（存量 tests/boundary 全缺，不能一次打红）：
#        · id 登记在 scripts/boundary-pending.txt → [WARN]，不阻断
#        · 未登记（新增 production 声明）→ [FAIL]，阻断
#        · 清单条目**实跑**已满足判据①② / 已非 production / 已不在索引 → [WARN] 提示移除
#      清单是「存量补测试的登记处」，不是放行名单：移出清单即转硬判据。
#      「陈旧条目」提示只认实跑 PASS——静态看着齐、编译却不过的文件不再被误报为已满足。
#
# 不主动联网、不调用 git、不修改仓库文件（go test 只写 GOCACHE 与 t.TempDir()）。
# 退出码 0 无 FAIL；1 有 FAIL；2 参数错误。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESETS_DIR="${PRESETS_DIR:-$ROOT/../kore-plugins/presets}"
INDEX_FILE="${INDEX_FILE:-$ROOT/../kore-plugins/index/plugins.json}"
PLUGIN_REPOS_DIR="${PLUGIN_REPOS_DIR:-$ROOT/..}"
# depth_level 已知待裁决清单（G-20）：存量不一致的登记处，新增不一致仍 FAIL
DEPTH_PENDING_FILE="${DEPTH_PENDING_FILE:-$ROOT/scripts/depth-level-pending.txt}"
# 判据① 边界用例已知待裁决清单（G-20）：存量补测试的登记处，新增声明缺失即 FAIL
BOUNDARY_PENDING_FILE="${BOUNDARY_PENDING_FILE:-$ROOT/scripts/boundary-pending.txt}"
# 判据① 真跑单仓上限（秒）：超过即杀进程组并按「不满足」处理，门禁不无限等
BOUNDARY_TEST_TIMEOUT="${BOUNDARY_TEST_TIMEOUT:-120}"
export BOUNDARY_TEST_TIMEOUT

usage() {
  cat <<'USAGE'
用法: bash scripts/presets-check.sh [preset.json ...] [--self-test]

  --self-test   只跑版本区间解析器用例（会证明不支持的写法确实报错）
  preset.json   指定要校验的预设文件，可多个（默认扫描 presets 目录）
  --help        打印本帮助

环境变量: INDEX_FILE / PRESETS_DIR / PLUGIN_REPOS_DIR / DEPTH_PENDING_FILE / BOUNDARY_PENDING_FILE / BOUNDARY_TEST_TIMEOUT
  DEPTH_PENDING_FILE    指向 depth_level 已知待裁决清单（默认 scripts/depth-level-pending.txt）
  BOUNDARY_PENDING_FILE 指向判据① 边界用例已知待裁决清单（默认 scripts/boundary-pending.txt）
  BOUNDARY_TEST_TIMEOUT 判据① go test 单仓上限秒数（默认 120；超时按不满足处理）

退出码: 0 无 FAIL；1 有 FAIL；2 参数错误。
USAGE
}

PRESETS=()
SELFTEST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --self-test) SELFTEST=1; shift ;;
    --*) echo "[FAIL] 未知参数: $1" >&2; usage >&2; exit 2 ;;
    *) PRESETS+=("$1"); shift ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "[FAIL] 需要 python3 解析 preset / index JSON（门禁不降级为 grep 猜测）"
  exit 1
fi

if [ "$SELFTEST" -eq 1 ]; then
  python3 - <<'PY'
import re
import sys

TOKEN_RE = re.compile(r"^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$")

failures = 0

def check(label, got, want):
    global failures
    ok = got == want
    if not ok:
        failures += 1
    print(f"[{'OK' if ok else 'FAIL'}] {label}: got={got!r} want={want!r}")

def parse_range(spec):
    spec = spec.strip()
    if not spec:
        raise ValueError("空区间")
    if "||" in spec:
        raise ValueError("不支持 || 多区间")
    parts = spec.split()
    if not parts:
        raise ValueError("空区间")
    out = []
    for tok in parts:
        m = TOKEN_RE.match(tok)
        if not m:
            raise ValueError(f"不支持的版本写法: {tok}")
        op = m.group(1) or "="
        ver = tuple(int(m.group(i)) for i in (2, 3, 4))
        out.append((op, ver))
    return out

def cmp_v(a, b):
    return (a > b) - (a < b)

def satisfies(version, spec):
    if spec.startswith("^"):
        base = tuple(int(x) for x in spec[1:].split("."))
        if len(base) != 3:
            raise ValueError(f"^ 需要三段版本: {spec}")
        if base[0] > 0:
            upper = (base[0] + 1, 0, 0)
        else:
            upper = (0, base[1] + 1, 0)
        return base <= version < upper
    if spec.startswith("~"):
        base = tuple(int(x) for x in spec[1:].split("."))
        if len(base) != 3:
            raise ValueError(f"~ 需要三段版本: {spec}")
        return base <= version < (base[0], base[1] + 1, 0)
    for op, ver in parse_range(spec):
        c = cmp_v(version, ver)
        if op == "=" and c != 0:
            return False
        if op == ">=" and c < 0:
            return False
        if op == ">" and c <= 0:
            return False
        if op == "<=" and c > 0:
            return False
        if op == "<" and c >= 0:
            return False
    return True

def expect_error(label, spec):
    global failures
    try:
        satisfies((0, 4, 3), spec)
        failures += 1
        print(f"[FAIL] {label}: {spec!r} 应被拒绝，但被当成合法区间")
    except ValueError:
        print(f"[OK] {label}: {spec!r} 按预期拒绝（不静默跳过）")

# 正向：精确 / caret / tilde / 比较器集合
check("精确命中", satisfies((0, 4, 3), "0.4.3"), True)
check("精确未命中", satisfies((0, 4, 4), "0.4.3"), False)
check("^0.4.1 命中 0.4.3", satisfies((0, 4, 3), "^0.4.1"), True)
check("^0.4.1 拒绝 0.5.0", satisfies((0, 5, 0), "^0.4.1"), False)
check("^1.2.3 命中 1.9.0", satisfies((1, 9, 0), "^1.2.3"), True)
check("^1.2.3 拒绝 2.0.0", satisfies((2, 0, 0), "^1.2.3"), False)
check("~0.4.1 命中 0.4.9", satisfies((0, 4, 9), "~0.4.1"), True)
check("~0.4.1 拒绝 0.5.0", satisfies((0, 5, 0), "~0.4.1"), False)
check(">=0.1.0 <0.2.0 命中 0.1.4", satisfies((0, 1, 4), ">=0.1.0 <0.2.0"), True)
check(">=0.1.0 <0.2.0 拒绝 0.2.0", satisfies((0, 2, 0), ">=0.1.0 <0.2.0"), False)
check("> 开区间", satisfies((0, 4, 3), ">0.4.3"), False)
check("<= 闭区间", satisfies((0, 4, 3), "<=0.4.3"), True)

# 反向：不支持的写法必须报错
for bad in ("*", "1.x", "latest", ">=1.0", "0.4", "^0.4", "~0.4", "0.4.3 || 0.5.0", ""):
    expect_error("拒绝非法写法", bad)

print("")
print(f"presets-check --self-test: {failures} fail")
sys.exit(1 if failures else 0)
PY
  exit $?
fi

if [ ! -f "$INDEX_FILE" ]; then
  echo "[SKIP] 无索引文件 $INDEX_FILE，G-18 校验跳过"
  exit 0
fi

if [ "${#PRESETS[@]}" -eq 0 ]; then
  shopt -s nullglob
  for f in "$PRESETS_DIR"/*.json; do
    if [ -f "$f" ]; then PRESETS+=("$f"); fi
  done
  shopt -u nullglob
  if [ "${#PRESETS[@]}" -eq 0 ]; then
    echo "[SKIP] 无预设文件（$PRESETS_DIR/*.json），G-18 校验跳过"
    exit 0
  fi
fi

# 资源红线（G-03）：常驻合计 / 单二进制
RSS_RED_MIB="${RSS_RED_MIB:-48}"
RSS_GOAL_MIB="${RSS_GOAL_MIB:-24}"
MAX_RESIDENT="${MAX_RESIDENT:-3}"
BIN_MAX_BYTES="${BIN_MAX_BYTES:-26214400}"

python3 - "$INDEX_FILE" "$PLUGIN_REPOS_DIR" "$RSS_RED_MIB" "$RSS_GOAL_MIB" \
         "$MAX_RESIDENT" "$BIN_MAX_BYTES" "$DEPTH_PENDING_FILE" "$BOUNDARY_PENDING_FILE" \
         "${PRESETS[@]}" <<'PY'
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

index_file = sys.argv[1]
repos_dir = sys.argv[2]
rss_red = float(sys.argv[3])
rss_goal = float(sys.argv[4])
max_resident = int(sys.argv[5])
bin_max = int(sys.argv[6])
pending_file = sys.argv[7]
boundary_pending_file = sys.argv[8]
preset_files = sys.argv[9:]

TOKEN_RE = re.compile(r"^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$")
SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

n_pass = 0
n_warn = 0
n_fail = 0

def semver(text, where):
    if not isinstance(text, str):
        raise ValueError(f"{where} 不是字符串: {text!r}")
    m = SEMVER_RE.match(text.strip())
    if not m:
        raise ValueError(f"{where} 不是三段版本 x.y.z: {text!r}")
    return tuple(int(m.group(i)) for i in (1, 2, 3))

def satisfies(version, spec):
    """区间解析：不支持的写法一律抛 ValueError（不静默跳过）。"""
    spec = spec.strip()
    if not spec:
        raise ValueError("空区间")
    if "||" in spec:
        raise ValueError("不支持 || 多区间")
    if spec.startswith("^"):
        base = semver(spec[1:], "caret 区间")
        upper = (base[0] + 1, 0, 0) if base[0] > 0 else (0, base[1] + 1, 0)
        return base <= version < upper
    if spec.startswith("~"):
        base = semver(spec[1:], "tilde 区间")
        return base <= version < (base[0], base[1] + 1, 0)
    for tok in spec.split():
        m = TOKEN_RE.match(tok)
        if not m:
            raise ValueError(f"不支持的版本写法: {tok}")
        op = m.group(1) or "="
        ver = tuple(int(m.group(i)) for i in (2, 3, 4))
        c = (version > ver) - (version < ver)
        if op == "=" and c != 0:
            return False
        if op == ">=" and c < 0:
            return False
        if op == ">" and c <= 0:
            return False
        if op == "<=" and c > 0:
            return False
        if op == "<" and c >= 0:
            return False
    return True

def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)

VALID_DEPTH = ("production", "basic")

def load_pending(path):
    """已知待裁决清单：一行一个插件 id，# 起注释。返回 (集合, 有序列表)。

    文件缺失 = 空清单：存量不一致会全部落进「新增不一致 → FAIL」，不静默放过。
    """
    ids = set()
    order = []
    if not os.path.isfile(path):
        return ids, order
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            pid = raw.split("#", 1)[0].strip()
            if not pid or pid in ids:
                continue
            ids.add(pid)
            order.append(pid)
    return ids, order

def memory_mib(pid):
    """常驻内存取自插件仓 info.json.resources.memory_mb（索引无此字段）。"""
    path = os.path.join(repos_dir, f"kore-plugin-{pid}", "info.json")
    if not os.path.isfile(path):
        return None, f"缺 ../kore-plugin-{pid}/info.json，无法核对常驻 RSS"
    try:
        info = load_json(path)
    except Exception as exc:  # noqa: BLE001
        return None, f"../kore-plugin-{pid}/info.json 解析失败: {exc}"
    res = info.get("resources")
    if not isinstance(res, dict):
        return None, f"../kore-plugin-{pid}/info.json 缺 resources（无 memory_mb）"
    mem = res.get("memory_mb")
    if not isinstance(mem, (int, float)) or mem <= 0:
        return None, f"../kore-plugin-{pid}/info.json.resources.memory_mb 非法: {mem!r}"
    return float(mem), None

# ── 索引 ──
try:
    index = load_json(index_file)
except Exception as exc:  # noqa: BLE001
    print(f"[FAIL] 索引解析失败: {index_file}: {exc}")
    print("")
    print("presets-check: 0 pass, 0 warn, 1 fail")
    sys.exit(1)

entries = index.get("plugins") if isinstance(index, dict) else None
if not isinstance(entries, list):
    print(f"[FAIL] 索引结构非预期（缺 plugins 数组）: {index_file}")
    print("")
    print("presets-check: 0 pass, 0 warn, 1 fail")
    sys.exit(1)

by_id = {}
for entry in entries:
    if isinstance(entry, dict) and isinstance(entry.get("id"), str):
        by_id[entry["id"]] = entry

print(f"索引: {index_file}（{len(by_id)} 个已收录插件）")
print(f"预设: {len(preset_files)} 个")
print("")

# ── 深度等级一致性（G-20）：索引 ↔ 仓库 info.json ──
pending_ids, pending_order = load_pending(pending_file)
repo_levels = {}
print("深度等级一致性（G-20）：索引 depth_level ↔ 仓库 info.json depth_level")
diff_ids = set()
for pid, entry in by_id.items():
    idx_level = entry.get("depth_level")
    if idx_level not in VALID_DEPTH:
        n_fail += 1
        print(f"[FAIL] 索引 depth_level 非法/缺失: {pid}={idx_level!r}"
              f"（只允许 {' / '.join(VALID_DEPTH)}）")
        continue
    repo_info_path = os.path.join(repos_dir, f"kore-plugin-{pid}", "info.json")
    if not os.path.isfile(repo_info_path):
        n_fail += 1
        print(f"[FAIL] 无法核对 depth_level: {pid} 缺 ../kore-plugin-{pid}/info.json")
        continue
    try:
        repo_info = load_json(repo_info_path)
    except Exception as exc:  # noqa: BLE001
        n_fail += 1
        print(f"[FAIL] 无法核对 depth_level: {pid}: ../kore-plugin-{pid}/info.json 解析失败: {exc}")
        continue
    repo_level = repo_info.get("depth_level")
    if repo_level not in VALID_DEPTH:
        n_fail += 1
        print(f"[FAIL] 仓库 depth_level 非法/缺失（G-20 必填）: {pid}={repo_level!r}"
              f"（../kore-plugin-{pid}/info.json）")
        continue
    repo_levels[pid] = repo_level
    if repo_level == idx_level:
        continue
    diff_ids.add(pid)
    if pid in pending_ids:
        n_warn += 1
        print(f"[WARN] depth_level 待裁决（已知存量，不阻断）: {pid}: "
              f"索引 {idx_level} / 仓库 {repo_level}"
              f"（已登记 {os.path.basename(pending_file)}，等产品裁决方向）")
    else:
        n_fail += 1
        print(f"[FAIL] depth_level 不一致（新增，阻断）: {pid}: "
              f"索引 {idx_level} / 仓库 {repo_level}"
              f"（未登记 {os.path.basename(pending_file)}；新仓新错不得进商店）")

for pid in pending_order:
    if pid in diff_ids:
        continue
    n_warn += 1
    if pid in by_id:
        print(f"[WARN] 待裁决清单陈旧条目: {pid} 的索引与仓库已一致 —— "
              f"裁决已落定，请从 {os.path.basename(pending_file)} 移除")
    else:
        print(f"[WARN] 待裁决清单陈旧条目: {pid} 已不在索引 —— "
              f"请从 {os.path.basename(pending_file)} 移除")

print(f"[INFO] depth_level 核对: {len(by_id)} 个已收录插件 · 不一致 {len(diff_ids)} 条"
      f"（已知待裁决 {len(diff_ids & pending_ids)} / 新增 {len(diff_ids - pending_ids)}）")
print("")

# ── 生产级声明内容（G-20 判据①②）：production 不得空口声明 ──
# 判据② = tests/fault/（故障注入）；判据① = tests/boundary/（边界用例：用例 + 并发 + 四类）。
# 此前 G-20 只比对「索引 ↔ 仓库」深度等级一致，两条判据在脚本里都没有执行面：
# 索引写 production + tests/fault/ 存在就能一路绿灯，判据① 从未被核对。
BOUNDARY_CATEGORIES = {
    "异常输入": ("异常输入", "非法输入", "非法参数", "invalid input", "malformed", "invalid-arg"),
    "并发": ("并发", "concurren", "parallel", "race"),
    "权限": ("权限", "permission", "unauthorized", "只读", "read-only", "need_root"),
    "资源耗尽": ("资源耗尽", "耗尽", "exhaust", "enospc", "磁盘满", "disk full", "out of memory", "oom", "ulimit", "cgroup"),
}
CONCURRENCY_RE = re.compile(r"t\.Parallel|go func|sync\.")


def go_test_files(root):
    """边界/故障目录下全部 *_test.go（递归，门禁不猜目录结构）。"""
    found = []
    if not os.path.isdir(root):
        return found
    for dirpath, _dirnames, names in os.walk(root):
        for name in names:
            if name.endswith("_test.go"):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def has_test_func(paths):
    return any(re.search(r"(?m)^func Test", read_text(path)) for path in paths)


def evidence_lines(paths):
    """四类覆盖的取证面：文件名 + 注释行（// 与 /* */ 块），不拿可执行代码凑关键词。"""
    for path in paths:
        yield os.path.basename(path)
        in_block = False
        for line in read_text(path).splitlines():
            stripped = line.strip()
            if in_block:
                yield stripped
                if "*/" in stripped:
                    in_block = False
                continue
            if stripped.startswith("/*"):
                yield stripped
                if "*/" not in stripped:
                    in_block = True
                continue
            if stripped.startswith("//") or stripped.startswith("#"):
                yield stripped


def missing_categories(paths, concurrency_ok):
    blob = "\n".join(evidence_lines(paths)).lower()
    missing = []
    for category, keys in BOUNDARY_CATEGORIES.items():
        if category == "并发":
            continue  # 并发由独立证据检查判定（比关键词更可靠），不重复报
        if not any(key.lower() in blob for key in keys):
            missing.append(category)
    return missing


BOUNDARY_TEST_TIMEOUT = float(os.environ.get("BOUNDARY_TEST_TIMEOUT", "120"))


def summarize_go_test_failure(output):
    """把 go test 失败输出压成一行证据：编译错误 > 进程被杀/panic/超时 > 测试失败行。"""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for line in lines:
        if re.search(r"\.go:\d+:\d+:", line):
            return line
    for key in ("signal: terminated", "panic:", "timed out", "timeout"):
        for line in lines:
            if key in line:
                return line
    for line in lines:
        if line.startswith("--- FAIL") or line.startswith("FAIL"):
            return line
    return lines[-1] if lines else "(go test 无输出)"


def run_boundary_tests(repo_dir):
    """真跑 `go test ./tests/boundary/ -count=1`，返回 (ok, detail, elapsed_s)。

    插件仓是独立 module，必须 GOWORK=off（否则被上级 go.work 串味）。
    子进程独立会话 + 超时杀进程组：边界用例会自起假 mysqld 等子进程，
    只杀 `go` 会留下孤儿进程，门禁必须收干净。
    """
    go_bin = shutil.which("go")
    if not go_bin:
        return False, "无法实跑 go test：PATH 中没有 go（门禁不降级为静态猜测）", 0.0
    env = dict(os.environ)
    env["GOWORK"] = "off"
    started = time.monotonic()
    proc = subprocess.Popen(
        [go_bin, "test", "./tests/boundary/", "-count=1"],
        cwd=repo_dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, start_new_session=True,
        # close_fds=False：像 shell 直接执行一样继承父进程已打开的 fd。默认 close_fds=True
        # 会把继承 fd 全关掉，改变 `ulimit -n` 类边界用例的实际 fd 预算（site 的 FD 耗尽
        # 用例实测会因此翻转），让门禁判的不是仓库自己 `go test` 的结果。
        close_fds=False,
    )
    try:
        output, _ = proc.communicate(timeout=BOUNDARY_TEST_TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        return (False, f"go test 超时（>{BOUNDARY_TEST_TIMEOUT:g}s，已杀进程组）",
                time.monotonic() - started)
    elapsed = time.monotonic() - started
    if proc.returncode == 0:
        return True, "", elapsed
    return False, summarize_go_test_failure(output), elapsed


boundary_pending_ids, boundary_pending_order = load_pending(boundary_pending_file)
print("生产级声明内容（G-20 判据①②）：production 的 tests/fault + tests/boundary")
n_prod = 0
n_prod_ok = 0
n_boundary_run = 0
n_boundary_pass = 0
n_boundary_time = 0.0
for pid in sorted(by_id):
    entry = by_id[pid]
    idx_level = entry.get("depth_level")
    # 任一侧声明 production 都算「生产级声明」：声明强于事实时必须被核对。
    if idx_level != "production" and repo_levels.get(pid) != "production":
        continue
    n_prod += 1
    fault_issues = []
    boundary_issues = []
    repo_dir = os.path.join(repos_dir, f"kore-plugin-{pid}")
    if not os.path.isdir(repo_dir):
        fault_issues.append(f"缺 ../kore-plugin-{pid}/ 仓库目录，无法核对判据①②")
    else:
        # 判据②（硬判据，待裁决清单不豁免）：故障注入用例必须真实存在
        fault_root = os.path.join(repo_dir, "tests", "fault")
        if not os.path.isdir(fault_root):
            fault_issues.append("判据②不满足：缺 tests/fault/")
        elif not has_test_func(go_test_files(fault_root)):
            fault_issues.append("判据②不满足：tests/fault/ 无含 func Test 的 *_test.go")

        # 判据①（分层上线）：目录 / 用例 / 并发证据 / 四类覆盖
        boundary_root = os.path.join(repo_dir, "tests", "boundary")
        boundary_files = go_test_files(boundary_root)
        if not os.path.isdir(boundary_root):
            boundary_issues.append("判据①不满足：缺 tests/boundary/")
        elif not has_test_func(boundary_files):
            boundary_issues.append("判据①不满足：tests/boundary/ 无含 func Test 的 *_test.go")
        else:
            concurrency_ok = any(CONCURRENCY_RE.search(read_text(path)) for path in boundary_files)
            if not concurrency_ok:
                boundary_issues.append(
                    "判据①不满足：tests/boundary/ 缺并发证据（t.Parallel/go func/sync. 0 命中）")
            missing = missing_categories(boundary_files, concurrency_ok)
            if missing:
                boundary_issues.append("判据①不满足：tests/boundary/ 四类覆盖缺 " + "、".join(missing))
            if not boundary_issues:
                # 判据① 真跑：静态看着齐不算数——编译失败 / 测试 FAIL / 超时一律不满足。
                # 静态已不满足的仓不跑：结论已定，跑了也不改变，性能上直接省掉。
                n_boundary_run += 1
                run_ok, run_detail, run_elapsed = run_boundary_tests(repo_dir)
                n_boundary_time += run_elapsed
                if run_ok:
                    n_boundary_pass += 1
                else:
                    boundary_issues.append(
                        "判据①不满足：go test ./tests/boundary/ -count=1 未通过"
                        f"（{run_elapsed:.1f}s）：{run_detail}")

    if fault_issues:
        for issue in fault_issues:
            print(f"[FAIL] production 判据②不满足（硬判据，清单不豁免）: {pid}: {issue}")
    if boundary_issues:
        if pid in boundary_pending_ids:
            n_warn += 1
            print(f"[WARN] production 判据①待裁决（已知存量，不阻断）: {pid}: "
                  + "；".join(boundary_issues)
                  + f"（已登记 {os.path.basename(boundary_pending_file)}，"
                    "静态/实跑未过，补边界用例见后续卡）")
        else:
            for issue in boundary_issues:
                print(f"[FAIL] production 判据①不满足（未登记待裁决清单，阻断）: {pid}: {issue}")
    if fault_issues or (boundary_issues and pid not in boundary_pending_ids):
        n_fail += 1
    if not fault_issues and not boundary_issues:
        n_prod_ok += 1
        if pid in boundary_pending_ids:
            n_warn += 1
            print(f"[WARN] 判据①待裁决清单陈旧条目: {pid} 静态核对与 go test 实跑均已满足判据①② —— "
                  f"请从 {os.path.basename(boundary_pending_file)} 移除（移除后转硬判据）")

for pid in boundary_pending_order:
    if pid in by_id and (by_id[pid].get("depth_level") == "production"
                         or repo_levels.get(pid) == "production"):
        continue  # production 条目已在上面逐条给出 WARN
    n_warn += 1
    reason = "已不在索引" if pid not in by_id else "已不是 production"
    print(f"[WARN] 判据①②待裁决清单陈旧条目: {pid} {reason} —— "
          f"请从 {os.path.basename(boundary_pending_file)} 移除")

print(f"[INFO] production 声明核对: {n_prod} 条 · 判据①②全满足 {n_prod_ok} 条"
      f"（其余为待裁决 WARN 或已 FAIL）")
print(f"[INFO] 判据① 实跑: 静态核对通过 {n_boundary_run} 个仓 → "
      f"go test PASS {n_boundary_pass} / 不通过 {n_boundary_run - n_boundary_pass} · "
      f"累计 {n_boundary_time:.1f}s（单仓上限 {BOUNDARY_TEST_TIMEOUT:g}s；"
      "静态已不满足的仓不跑）")
print("")

for path in preset_files:
    name = os.path.basename(path)
    problems = []
    warns = []
    resident_mib = 0.0
    resident_ids = []
    pkg_bytes = 0
    refs = 0

    try:
        preset = load_json(path)
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] {name}: JSON 解析失败: {exc}")
        n_fail += 1
        continue

    if not isinstance(preset, dict):
        print(f"[FAIL] {name}: 顶层不是 JSON 对象")
        n_fail += 1
        continue

    pid_preset = preset.get("id")
    if not isinstance(pid_preset, str) or not pid_preset:
        problems.append("preset 缺 id 字段")
    elif os.path.splitext(name)[0] != pid_preset:
        problems.append(f"preset.id={pid_preset} ≠ 文件名 {name}")

    plugins = preset.get("plugins")
    if not isinstance(plugins, list):
        problems.append("缺 plugins 数组")
        plugins = []

    for idx, item in enumerate(plugins):
        where = f"plugins[{idx}]"
        if not isinstance(item, dict):
            problems.append(f"{where} 不是对象")
            continue
        pid = item.get("id")
        spec = item.get("version")
        desired = item.get("desired", "enabled")

        if not isinstance(pid, str) or not pid:
            problems.append(f"{where} 缺 id")
            continue
        if not isinstance(spec, str) or not spec:
            problems.append(f"id={pid} 缺 version 区间")
            continue
        if desired not in ("enabled", "disabled"):
            problems.append(f"id={pid} desired={desired!r} 非法（只允许 enabled/disabled）")
            continue

        refs += 1
        entry = by_id.get(pid)
        if entry is None:
            problems.append(f"id={pid} 在索引中不存在（{len(by_id)} 个已收录 id 无此项）")
            continue

        actual = entry.get("version")
        try:
            actual_ver = semver(actual, f"索引 {pid}.version")
        except ValueError as exc:
            problems.append(f"id={pid} 索引版本不可解析: {exc}")
            continue

        try:
            ok = satisfies(actual_ver, spec)
        except ValueError as exc:
            problems.append(f"id={pid} 区间 {spec!r} 不可解析: {exc}")
            continue
        if not ok:
            problems.append(f"id={pid} 区间 {spec!r} 不被索引实际版本 {actual} 满足")
            continue

        size = entry.get("size_bytes")
        if isinstance(size, int) and size > 0:
            pkg_bytes += size
            if size > bin_max:
                problems.append(
                    f"id={pid} 包体积 {size} B 超单二进制红线 {bin_max} B（G-03）"
                )

        if desired == "enabled" and entry.get("lifecycle") == "resident":
            mem, why = memory_mib(pid)
            if mem is None:
                problems.append(f"id={pid} {why}")
            else:
                resident_mib += mem
                resident_ids.append((pid, mem))

    # out_of_box × depth_level（G-20 明文）：basic 插件不得被预设标为「开箱可用」。
    # 判据落在索引（商店实际下发的值）上，不看 desired —— 引用即「标为开箱可用」。
    if preset.get("out_of_box") is True:
        for idx, item in enumerate(plugins):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            pid = item["id"]
            entry = by_id.get(pid)
            if entry is None:
                continue  # id 不可解析已在上方按 FAIL 报过，不重复计
            level = entry.get("depth_level")
            if level != "production":
                problems.append(
                    f"out_of_box=true 引用了 depth_level={level!r} 的插件 {pid}"
                    f"（desired={item.get('desired', 'enabled')}）"
                    f"—— G-20「basic 插件不得被预设标为开箱可用」"
                )

    # 常驻资源红线（G-03）：合计 RSS / 同时常驻数
    if resident_mib > rss_red:
        problems.append(
            f"常驻 RSS 合计 {resident_mib:g} MiB 超红线 {rss_red:g} MiB"
            f"（{', '.join(f'{p}={m:g}' for p, m in resident_ids)}）"
        )
    elif resident_mib > rss_goal:
        warns.append(f"常驻 RSS 合计 {resident_mib:g} MiB 超目标 {rss_goal:g} MiB（未超红线）")
    if len(resident_ids) > max_resident:
        problems.append(
            f"同时常驻 {len(resident_ids)} 个 > 上限 {max_resident}（G-03）: "
            + ", ".join(p for p, _ in resident_ids)
        )

    detail = (
        f"{refs} 个引用 · 常驻 {len(resident_ids)} 个 = {resident_mib:g} MiB"
        f"（红线 {rss_red:g} / 目标 {rss_goal:g}）· 包体积 {pkg_bytes / 1048576:.2f} MiB"
    )

    if problems:
        n_fail += 1
        for problem in problems:
            print(f"[FAIL] {name}: {problem}")
    elif warns:
        n_warn += 1
        for warn in warns:
            print(f"[WARN] {name}: {warn}")
        print(f"[OK] {name}: {detail}")
    else:
        n_pass += 1
        print(f"[OK] {name}: {detail}")

print("")
print("检查范围: id 可在索引解析 + 版本区间被实际版本满足（精确 / ^ / ~ / 比较器集合）"
      " + 常驻 RSS 红线与目标 + 同时常驻数 + 单插件包体积"
      " + 索引↔仓库 depth_level 一致性（G-20：新增不一致 FAIL / 已知待裁决 WARN）"
      " + out_of_box 预设不得引用 non-production 插件（G-20）"
      " + production 判据② tests/fault/ 与判据① tests/boundary/（用例/并发/四类静态核对"
      " + 静态通过后 GOWORK=off go test ./tests/boundary/ -count=1 真跑；"
      "清单内 WARN / 清单外 FAIL）")
print(f"presets-check: {n_pass} pass, {n_warn} warn, {n_fail} fail")
sys.exit(1 if n_fail else 0)
PY
