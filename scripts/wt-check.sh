#!/usr/bin/env bash
# wt-check — 临时 worktree / 临时分支残留检查（WARN 级：任何情况 exit 0，不阻断日常提交）
# 判定四件事：① 工作树数量应为 1（仅主工作树）② 无 wt-*/tmp-* 残留分支
#            ③ .git/worktrees 元数据条目与工作树数一致 ④ 工作区状态无 /tmp/wt- 路径
# 残留属卫生问题：里程碑收口前必须清空，由人工判；本脚本只负责发现与列清单。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0
WARN=0

ok()     { PASS=$((PASS + 1)); printf '[OK] %s\n' "$*"; }
warn()   { WARN=$((WARN + 1)); printf '[WARN] %s\n' "$*"; }
detail() { printf '       %s\n' "$*"; }

# ---------------- 1) 工作树数量 ----------------
WT_TOTAL=$(git worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || true)
WT_TOTAL=${WT_TOTAL:-0}
if [ "$WT_TOTAL" -le 1 ]; then
  ok "工作树数量 ${WT_TOTAL}（仅主工作树）"
else
  warn "工作树数量 ${WT_TOTAL} > 1（里程碑收口前必须清空临时 worktree）"
  git worktree list --porcelain 2>/dev/null | awk '/^worktree /{printf "       %s\n", $2}' | head -10
fi

# ---------------- 2) 残留临时分支 ----------------
BRANCHES=$(git branch --list 'wt-*' 'tmp-*' 2>/dev/null | sed 's/^[* ]*//' | sed '/^$/d' || true)
if [ -z "$BRANCHES" ]; then
  ok "无 wt-*/tmp-* 残留分支"
else
  warn "残留临时分支（里程碑收口前必须删除）"
  printf '%s\n' "$BRANCHES" | head -10 | while IFS= read -r b; do
    detail "$b"
  done
fi

# ---------------- 3) .git/worktrees 元数据一致性 ----------------
DG_COUNT=$(find .git/worktrees -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
DG_COUNT=${DG_COUNT:-0}
EXPECT=$((WT_TOTAL - 1))
if [ "$EXPECT" -lt 0 ]; then
  EXPECT=0
fi
if [ "$DG_COUNT" -eq "$EXPECT" ]; then
  ok ".git/worktrees 条目 ${DG_COUNT} 与工作树数一致（共 ${WT_TOTAL} 个，主树不计）"
else
  warn "不一致：git worktree list=${WT_TOTAL}，.git/worktrees 条目=${DG_COUNT}（残留元数据需 git worktree prune）"
fi

# ---------------- 4) 工作区状态里的 /tmp/wt- 路径 ----------------
ST_HITS=$(git status --porcelain 2>/dev/null | grep -F '/tmp/wt-' || true)
if [ -z "$ST_HITS" ]; then
  ok "工作区状态无 /tmp/wt- 残留路径"
else
  warn "工作区状态含 /tmp/wt- 路径（里程碑收口前必须清空）"
  printf '%s\n' "$ST_HITS" | head -10 | while IFS= read -r l; do
    detail "$l"
  done
fi

printf '\n'
printf 'wt-check: %d pass, %d warn\n' "$PASS" "$WARN"
if [ "$WARN" -gt 0 ]; then
  printf '提示：worktree 残留属卫生问题，不阻断日常提交；里程碑收口前必须清空。\n'
fi
# 卫生检查不阻断提交：任何情况都 exit 0
exit 0
