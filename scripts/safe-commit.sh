#!/usr/bin/env bash
# kore 多 agent 并行安全提交 —— 私有索引 + commit-tree + CAS 前进，绝不改写历史
# 用法: scripts/safe-commit.sh "<commit message>" <path> [<path>...]
# 退出码: 0 成功；1 用法/校验失败；3 CAS 冲突（期间 HEAD 被他方推进）
set -euo pipefail

die()  { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
info() { printf '[INFO] %s\n' "$*"; }
usage() {
  printf '用法: %s "<commit message>" <path> [<path>...]\n' "${0##*/}" >&2
  printf '  只提交显式列出的路径；用私有索引构建提交，不触碰共享 .git/index。\n' >&2
  printf '  分支以 CAS 推进：期间 HEAD 变化则安全失败，你的改动不会丢失。\n' >&2
}

# ---------------------------------------------------------------- 1 参数校验
if [ "$#" -lt 2 ]; then
  usage; die "参数不足（需要 1 条消息 + 至少 1 个路径）"
fi
MSG="$1"; shift
if [ -z "${MSG//[[:space:]]/}" ]; then
  usage; die "commit message 不能为空"
fi

ROOT=$(cd "$(git rev-parse --show-toplevel)" && pwd) || die "不在 git 仓库内"
PATHS=()
for arg in "$@"; do
  abs=$(realpath -ms -- "$arg")
  case "$abs" in
    "$ROOT"/?*) PATHS+=("${abs#"$ROOT"/}") ;;
    *) die "路径不在本仓库内: $arg" ;;
  esac
done
cd "$ROOT"
for p in "${PATHS[@]}"; do
  [ -e "$p" ] || die "路径不存在: $p"
  [ -f "$p" ] || die "不是普通文件（本脚本只接受文件路径）: $p"
done
BR=$(git symbolic-ref --short -q HEAD) || die "HEAD 处于分离状态，拒绝提交"
OLD=$(git rev-parse HEAD)

# ---------------------------------------------------------------- 2 私有索引
IDX=$(mktemp) || die "无法创建临时索引"
trap 'rm -f "$IDX"' EXIT
export GIT_INDEX_FILE="$IDX"
git read-tree HEAD
for p in "${PATHS[@]}"; do
  git update-index --add -- "$p"
done

# ---------------------------------------------------------------- 3 精确校验
EXPECTED=$(printf '%s\n' "${PATHS[@]}" | LC_ALL=C sort -u)
ACTUAL=$(git diff --cached --name-only | LC_ALL=C sort -u)
if [ "$EXPECTED" != "$ACTUAL" ]; then
  warn "实际暂存集合与传入路径不一致（多一个少一个都不提交）："
  comm -23 <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$ACTUAL") \
    | sed -e 's/^/      缺少（要求提交但无改动）: /' >&2 || true
  comm -13 <(printf '%s\n' "$EXPECTED") <(printf '%s\n' "$ACTUAL") \
    | sed -e 's/^/      多出（未要求却被暂存）: /' >&2 || true
  die "校验失败，未做任何提交"
fi
if [ -z "$ACTUAL" ]; then
  die "这些路径相对 HEAD 没有内容变化，无需提交"
fi

# ---------------------------------------------------------------- 4 提交对象
TREE=$(git write-tree)
NEW=$(git commit-tree "$TREE" -p "$OLD" -m "$MSG")

# ---------------------------------------------------------------- 5 CAS 前进
if ! git update-ref "refs/heads/$BR" "$NEW" "$OLD" 2>/dev/null; then
  printf '[FAIL] HEAD 已变化（期望 %s），拒绝覆盖他人提交。\n' "${OLD:0:12}" >&2
  printf '       你的改动未丢失，请重跑本脚本。\n' >&2
  exit 3
fi
unset GIT_INDEX_FILE

# 6 共享索引归位：只把自己提交的条目指向新 tree，不触碰他人暂存内容。
#   不做这步，共享索引会停留在旧 HEAD，把本提交显示成「已暂存的删除」，
#   下一个裸 git commit 的 agent 会顺手把本提交改回去（事故 ① 的成因）。
if ! git ls-tree -r -z --full-tree "$NEW" -- "${PATHS[@]}" \
  | while IFS= read -r -d '' rec; do
      meta=${rec%%$'\t'*}; path=${rec#*$'\t'}
      set -- $meta
      printf '%s %s\t%s\0' "$1" "$3" "$path"
    done \
  | git update-index -z --index-info; then
  warn "共享索引归位失败（可能有他人持有 index.lock），提交本身已成功。"
  warn "请手动刷新：git update-index --refresh；勿用任何改写索引或历史的命令。"
fi

# ---------------------------------------------------------------- 7 输出
printf '[OK] 已提交 %s → 分支 %s\n' "$NEW" "$BR"
printf '[OK] 文件清单（%d 项）：\n' "${#PATHS[@]}"
for p in "${PATHS[@]}"; do printf '     %s\n' "$p"; done
printf '[INFO] 未 push。推送前请先 git pull --rebase 或由 lead 统一推送。\n'
