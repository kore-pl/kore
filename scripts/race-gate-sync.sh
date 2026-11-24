#!/usr/bin/env bash
# race 门禁渲染（唯一入口，幂等）：把 -race 段写进 24 个插件仓的 Makefile。
#
# 用法: bash scripts/race-gate-sync.sh [--check|--dry-run] [repo-dir ...]
#   --check    只报告差异：有差异 exit 1（CI / 本地核对漂移用）
#   --dry-run  只打印将写哪些文件，不落盘
#   repo-dir   指定仓库目录；默认扫描 ../kore-plugin-*
#
# 单一真源：scripts/plugin-templates/plugin-repo/Makefile.race.mk
# 渲染内容（全部幂等，重复运行 0 变更）：
#   1. `.PHONY` 追加 race（已有则不动）
#   2. 文件末尾的 race 目标块（`# >>> race target` … `# <<< race target` 标记内整段替换）
#   3. `check` 目标体内追加独立段：先 race 后判（`# race-seg:begin` … `# race-seg:end`）
#   4. `.github/workflows/ci.yml` 按同一模板写一份（含显式 `make race` 步骤）
#      —— 只写 CI 这一个文件，其余八件套仍归 plugin-oss-sync.sh 管，避免越权覆盖漂移。
# 不碰 build / dist / clean / fault / e2e，不动测试与业务代码，不联网、不调用 git。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TPL="$ROOT/scripts/plugin-templates/plugin-repo/Makefile.race.mk"
CI_TPL="$ROOT/scripts/plugin-templates/plugin-repo/.github/workflows/ci.yml"

MODE="apply"
REPOS=()

usage() {
  cat <<'USAGE'
用法: bash scripts/race-gate-sync.sh [--check|--dry-run] [repo-dir ...]

  （无参数）   扫描 ../kore-plugin-* 并渲染
  --check      只报告差异，有差异 exit 1
  --dry-run    只打印将写哪些文件，不落盘
  --help       打印本帮助

退出码: 0 全部一致 / 写入成功；1 有差异或渲染失败；2 参数错误。
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --dry-run) MODE="dryrun"; shift ;;
    --help|-h) usage; exit 0 ;;
    --*) echo "[FAIL] 未知参数: $1" >&2; usage >&2; exit 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

[ -f "$TPL" ] || { echo "[FAIL] 缺模板: $TPL" >&2; exit 1; }
[ -f "$CI_TPL" ] || { echo "[FAIL] 缺 CI 模板: $CI_TPL" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "[FAIL] 需要 python3" >&2; exit 1; }

if [ "${#REPOS[@]}" -eq 0 ]; then
  shopt -s nullglob
  for d in "$ROOT"/../kore-plugin-*; do
    [ -d "$d" ] && REPOS+=("$d")
  done
  shopt -u nullglob
  if [ "${#REPOS[@]}" -eq 0 ]; then
    echo "[SKIP] 无兄弟仓（$ROOT/.. 下没有 kore-plugin-*）"
    exit 0
  fi
fi

CHANGED=0
FAILED=0

for repo in "${REPOS[@]}"; do
  name="$(basename "$repo")"
  if [ ! -f "$repo/Makefile" ]; then
    echo "[FAIL] $name: 缺 Makefile"
    FAILED=1
    continue
  fi
  out="$(python3 - "$repo/Makefile" "$TPL" "$MODE" <<'PY'
import sys, pathlib

mk_path, tpl_path, mode = sys.argv[1], sys.argv[2], sys.argv[3]
mk = pathlib.Path(mk_path).read_text(encoding="utf-8")
tpl = pathlib.Path(tpl_path).read_text(encoding="utf-8").rstrip("\n")

BEGIN = "# >>> race target (rendered by kore/scripts/race-gate-sync.sh; do not edit) >>>"
END = "# <<< race target (rendered by kore/scripts/race-gate-sync.sh; do not edit) <<<"
SEG_BEGIN = "\t# race-seg:begin (rendered by kore/scripts/race-gate-sync.sh; do not edit)"
SEG_END = "\t# race-seg:end (rendered by kore/scripts/race-gate-sync.sh; do not edit)"
SEG = [SEG_BEGIN, "\t@$(MAKE) --no-print-directory race", SEG_END]

lines = mk.split("\n")
changed = []

# 1) .PHONY 补 race
phony_idx = next((i for i, l in enumerate(lines) if l.startswith(".PHONY:")), None)
if phony_idx is not None and " race" not in (" " + lines[phony_idx].split(":", 1)[1] + " "):
    parts = lines[phony_idx].split()
    parts.insert(parts.index("check") + 1, "race")
    lines[phony_idx] = " ".join(parts)
    changed.append("PHONY")

mk = "\n".join(lines)

# 2) race 目标块：标记内整段替换；无标记则追加到文件末尾
block = f"{BEGIN}\n{tpl}\n{END}"
if BEGIN in mk:
    start = mk.index(BEGIN)
    end = mk.index(END, start) + len(END)
    new = mk[:start] + block + mk[end:]
    if new != mk:
        mk = new
        changed.append("race-block")
else:
    mk = mk.rstrip("\n") + "\n\n" + block + "\n"
    changed.append("race-block")

# 3) check 目标体内独立段：标记内替换；无标记则插到最后一条 recipe 之后
lines = mk.split("\n")
seg_start = next((i for i, l in enumerate(lines) if l == SEG_BEGIN), None)
if seg_start is not None:
    seg_end = next(i for i in range(seg_start, len(lines)) if lines[i] == SEG_END)
    new_lines = lines[:seg_start] + SEG + lines[seg_end + 1:]
else:
    check_idx = next((i for i, l in enumerate(lines) if l.rstrip() == "check:"), None)
    if check_idx is None:
        print("NO_CHECK", end="")
        sys.exit(3)
    last = check_idx
    j = check_idx + 1
    while j < len(lines) and (lines[j].startswith("\t") or lines[j].strip() == ""):
        if lines[j].startswith("\t"):
            last = j
        j += 1
    new_lines = lines[:last + 1] + SEG + lines[last + 1:]

mk2 = "\n".join(new_lines)
if mk2 != mk:
    mk = mk2
    changed.append("check-seg")

path = pathlib.Path(mk_path)
if mode == "check":
    if changed:
        print("CHANGED:" + ",".join(changed), end="")
        sys.exit(1)
    print("SAME", end="")
    sys.exit(0)
if mode == "dryrun":
    print("WOULD_CHANGE:" + ",".join(changed), end="")
    sys.exit(0)
if changed:
    path.write_text(mk, encoding="utf-8")
    print("WROTE:" + ",".join(changed), end="")
else:
    print("SAME", end="")
PY
)" || rc=$?
  rc="${rc:-0}"
  case "$out" in
    SAME) echo "[OK] $name: 已一致" ;;
    WROTE:*|WOULD_CHANGE:*)
      CHANGED=$((CHANGED + 1))
      if [ "$MODE" = "dryrun" ]; then echo "[DRY ] $name: ${out#*:}"; else echo "[OK] $name: 渲染 ${out#*:}"; fi ;;
    CHANGED:*)
      CHANGED=$((CHANGED + 1)); echo "[FAIL] $name: 与模板不一致（${out#*:}）— 跑 bash scripts/race-gate-sync.sh 重渲染" ;;
    NO_CHECK)
      FAILED=1; echo "[FAIL] $name: 无 check 目标，无法挂 race 段" ;;
    *)
      FAILED=1; echo "[FAIL] $name: 渲染异常（exit=$rc）" ;;
  esac

  # CI：与 Makefile 同一次渲染，保证「本地 make check 跑 race」和「CI 跑 race」同源。
  ci="$repo/.github/workflows/ci.yml"
  mkdir -p "$repo/.github/workflows"
  if [ -f "$ci" ] && cmp -s "$CI_TPL" "$ci"; then
    :
  elif [ "$MODE" = "check" ]; then
    CHANGED=$((CHANGED + 1)); echo "[FAIL] $name: .github/workflows/ci.yml 与模板不一致 — 跑 bash scripts/race-gate-sync.sh 重渲染"
  elif [ "$MODE" = "dryrun" ]; then
    echo "[DRY ] $name: .github/workflows/ci.yml"
  else
    cp "$CI_TPL" "$ci"; CHANGED=$((CHANGED + 1)); echo "[OK] $name: 渲染 .github/workflows/ci.yml（含 make race）"
  fi
done

echo ""
echo "race-gate-sync: 扫描 ${#REPOS[@]} 仓 · 变更 $CHANGED · 失败 $FAILED"
if [ "$FAILED" -ne 0 ]; then exit 1; fi
if [ "$MODE" = "check" ] && [ "$CHANGED" -ne 0 ]; then exit 1; fi
exit 0
