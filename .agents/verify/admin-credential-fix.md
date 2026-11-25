> 状态: factual record · 归属: fix-admin-credential · 更新: 2026-11-25 · 里程碑: R25
> 任务: 修复离线 install 覆盖共享 data/initial-admin-credential 导致文件口令与配置哈希不匹配、用户无法登录（承接 site-082-fix / local-update-exec）
> 硬约束遵守: commit 不 push、未触发 CI、未改插件代码/索引/版本/dist、未删数据；root 操作只走 dsh-root；口令明文未 echo/落报告/入 argv；临时脚本/凭据临时文件用完即删。

# 管理员凭据修复报告（fix-admin-credential）

## 一句话结论

**凭据文件已重建并可用：旧文件口令与配置哈希 MISMATCH（离线 install 覆盖所致），已用 kored admin-password --set --stdin 生成新口令并写入 kore/data/initial-admin-credential（0600、gitignore 命中），重建后 PBKDF2 比对 MATCH，登录 POST /api/v1/auth/login=200 验证通过；请在自己终端 cat 该文件读取口令。**

## 1. 只读定位（G-30 / G-29）

| 项 | 结果 |
| --- | --- |
| systemd unit ExecStart | /home/pt/Work/GolandProjects/kore-pl/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore-pl/kore/.kore-local.yaml（KORE_HOME=/home/pt/.../kore） |
| 配置路径口径 | config.ResolvePath = KORE_CONFIG > --config > profile 默认；kored admin-password --config 与 serve 同路径；resolveCLITargets 只做 Abs 归一，不改路径选择 |
| 配置哈希字段 | kore/.kore-local.yaml → auth.admin_password_hash（格式 pbkdf2-sha256$<iter>$<salt>$<hash>，600000 次） |
| 凭据文件路径 | <install>=/home/pt/Work/GolandProjects/kore-pl/kore → kore/data/initial-admin-credential（InstallRoot()/data/initial-admin-credential，KORE_HOME 指向 kore/） |
| 起点凭据文件 | 存在，mode=600 size=25，mtime 2026-11-25 19:43:19 +0800（离线 install 触发 ensureInitialAdminCredential 写入的新口令，与配置哈希不匹配） |
| gitignore | git check-ignore -v data/initial-admin-credential → .gitignore:68:/data/initial-admin-credential；配置 .kore-local.yaml → .gitignore:59:.kore-local* |
| 配置权限 | .kore-local.yaml mode=600；auth.initialized=true、auth.must_change_password=true |

## 2. 程序比对（不输出明文，G-30）

命令：python3 读凭据文件明文 + 配置里的 salt，按 hashlib.pbkdf2_hmac('sha256', plain, salt, 600000, dklen=len(key)) 派生并与配置哈希逐字节比较；只输出 MATCH / MISMATCH。

| 阶段 | 结果 | 退出码 |
| --- | --- | --- |
| 重建前 | MISMATCH | 0 |
| 重建后 | MATCH | 0 |

> 报告与输出中均无明文、无哈希值；口令只存在于 0600 凭据文件中。

## 3. 重建与验证

| 步骤 | 命令 / 方式 | 结果 / 退出码 |
| --- | --- | --- |
| 生成新口令 | kored admin-password --set --stdin --config <install>/.kore-local.yaml；口令进程内生成（secrets.token_urlsafe），经 stdin 单行喂入，不进 argv / 日志 / 本轮输出 | SET_EXIT=0 |
| 写凭据文件 | umask 077 + chmod 600 + mv 原子替换 <install>/data/initial-admin-credential（内容与代码 plain+"\n" 一致） | CRED_MODE=600，CRED_SIZE=33 |
| 哈希生效 | dsh-root kill -HUP <MainPID>（systemd MainPID 由 dsh-root systemctl show 取，SIGHUP 走 applyAuthCredential 同步新哈希 + must_change 并吊销旧会话，不重启） | SIGHUP_EXIT=0 |
| 健康检查 | curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz | HEALTHZ=200 |
| 登录验证 | POST /api/v1/auth/login，JSON body 由 python 从 0600 凭据文件读入后经 stdin 管道给 curl --data-binary @-，口令不进 argv | LOGIN_HTTP=200（两次独立复跑均 200） |
| 首登闸门 | GET /api/v1/auth/session 带会话 cookie → 403 code=E_UNAUTHORIZED message=首次登录请先设置新口令 | 符合 ADR-0055 §4 预期（must_change=true 仅放行改密/登出） |
| 临时产物 | 口令临时文件、cookie jar 用后 rm -f；ls 复核 | CLEAN_NO_LEFTOVER |

## 4. 用户后续动作（必须）

新口令已写入 <install>/data/initial-admin-credential（权限 0600）。请在自己的终端执行 cat /home/pt/Work/GolandProjects/kore-pl/kore/data/initial-admin-credential 读取口令（本 agent 不会、也不允许在任何输出里显示明文）。

该口令可登录面板（已验证 200）。因 auth.must_change_password=true（ADR-0055，CLI 重置强制置位），登录后会被首登闸门挡住，只放行改密端点与登出：

- 改密端点：POST /api/v1/auth/password，body 字段 current_password（文件里的口令）与 new_password（自设新口令）；需带会话 cookie + X-Kore-CSRF 头（双提交，从 kore_csrf cookie 读）。
- 在面板「设置 → 修改口令」完成改密即可；成功后 must_change 清除、旧会话吊销、一次性凭据文件被内核自动删除（改完后此文件将消失，属正常）。
- 若通过 API 调用改密，新口令长度至少 8 字符且不得与当前口令相同（passwordMinLen）。

## 5. 未做 / 边界

- 未 push、未 tag、未触发任何 CI。
- 未重启服务（SIGHUP 热同步生效）、未改 state.db / plugins / index / 插件代码。
- 未在任何文件、日志、报告、argv、对话中写入明文口令；所有比对只在程序内进行、只输出 MATCH/MISMATCH。
- 未替用户完成首登改密（凭据属用户操作，且改密会消费一次性文件）。

## 6. 证据摘要（供父 agent 核对）

- HASH_MATCH：重建前 MISMATCH / 重建后 MATCH（python PBKDF2 程序比对，退出码 0）
- SET_EXIT=0；CRED_MODE=600 CRED_SIZE=33；GITIGNORE=.gitignore:68
- SIGHUP_EXIT=0；HEALTHZ=200；LOGIN_HTTP=200（两次）；SESSION_HTTP=403（gate message 确认 must_change）
- CLEAN_NO_LEFTOVER
