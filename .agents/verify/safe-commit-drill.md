# 安全提交脚本演练（scripts/safe-commit.sh）

本文件是 `scripts/safe-commit.sh` 的常驻演练证据：它本身就是被该脚本提交的产物，证明脚本可用。

## 脚本用途

多 agent 共用一个仓库时有三次事故：提交卷进他人暂存文件、`git reset --hard` 弃掉别人提交、`git commit --amend` 覆盖队友提交。根因都是**共享索引 + 改写历史**。

`scripts/safe-commit.sh "<message>" <path>...` 用私有索引（`GIT_INDEX_FILE`）构建提交，`commit-tree` 生成对象，`update-ref` 以 CAS 方式前进分支，从机制上不做改写历史的操作。

## 用法与退出码

`scripts/safe-commit.sh "chore(scripts): 说明" scripts/safe-commit.sh` → 0 成功；路径校验不符 → 1；期间 HEAD 被他方推进 → 3（CAS 拒绝，改动不丢失）。

约束：只提交显式列出的路径，绝不 `git add .`；不 push，推送由 lead 统一协调。
