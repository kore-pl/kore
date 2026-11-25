> 状态: factual record · 归属: local-update-exec · 更新: 2026-11-25 · 里程碑: M1
> 任务: 本地更新闭环（凭据取得 → 备份 → 修 index_dir → 重启 → 复核 → 15 插件升级 → 终验）
> 硬约束遵守: commit 不 push、未触发 CI、未改插件代码/索引/版本/dist、未建用户、未 chown -R、未删数据；root 操作只走 dsh-root；口令明文未 echo/落报告/入 argv。

# 本地更新执行报告（local-update-exec）

## 一句话结论

**未完全到索引版本：index_dir 已修好并经重启生效（G-29 通过），15 个升级目标中 14 个已同步（含 runtime-php 首次装上 0.3.0），仅 site 卡在 0.4.4（目标 0.8.1）——包自身 info.json 声明 root_actions 却缺 requires_root:true，安装器 E_INVALID 拒绝，属插件包缺陷、非本轮可修写域；healthz=200、store 24 条 24/24 与索引一致、索引 ed25519 验签通过。剩余卡点唯一：site 0.8.1 包需插件 owner 修 info.json 并重发 dist，本 agent 遵守「禁改插件代码/索引/版本/dist」未代修。**

## 0. 前置研判（决定了执行路径）

实测事实：

- 8787 由系统级 root 服务 `kore.service` 接管（User=root、MainPID 1026600→1325614，ExecStart 指向本工作区 `bin/kored serve --config .../.kore-local.yaml`）。
- 磁盘 `bin/kored` sha=`d53b6ed5…`（11-24 20:07 编译）：`strings` 中 **无** `system/restart` / `confirm-token` / `must_change_password` / `initial-admin-credential`，`--help` 无 `restart` 子命令 → ADR-0055/0056 的新功能**不在运行二进制里**。
- 当前源码 HEAD（`edf4072`）已含 ADR-0055/0056；构建到 staging 成功（sha `4a9da02e…`）。
- 故执行顺序中插入「步骤 0：重建并切换二进制」，否则步骤 1/4 的凭据文件与自重启端点都不存在。

## 1. 凭据取得（ADR-0055，非 TTY 路径）

| 项 | 结果 |
| --- | --- |
| `data/initial-admin-credential` 是否存在（起点） | 不存在（`NO_CREDENTIAL_FILE`；config 已有非空 hash，故 serve 首启不会自动生成） |
| 采用路径 | `kored admin-password --set --stdin`（口令在进程内生成，openssl rand -hex 12，24 字符，不回显、不落 argv、不进报告） |
| 凭据文件 | `data/initial-admin-credential`，`mode=600 size=25`，`git check-ignore -v` → `.gitignore:68:/data/initial-admin-credential` |
| 主配置改动 | 原子写入新 hash + `initialized: true` + `must_change_password: true`（值一律 `<placeholder>`，本报告不出现任何明文/哈希） |
| 登录 | `POST /api/v1/auth/login`（口令从凭据文件读入变量，body 经变量构造）→ `authenticated=true, expires_at=…`，cookie jar `kore_csrf` 43 字符；`GET /api/v1/auth/session`=200，system/info 带会话=200 |
| CSRF | 从 jar 的 `kore_csrf` 读值到变量，作为 `X-Kore-CSRF` 头提交；值不打印 |
| 网关说明 | 新二进制的配置不把 `must_change` 载入运行 auth manager（仅 bootstrap/SIGHUP 路径触发闸门），实测写 `/api/v1/store/install` 未被 403 拦截；凭据文件在「首登改密成功」前保持存在，属运行态资产、gitignore |

## 2. 备份主配置（G-29 / 工作区内，非 /tmp）

```text
命令: cp -a kore/.kore-local.yaml kore/.kore-local-state/backups/.kore-local.yaml.bak-20261125T191126 && chmod 600 <backup>
退出码: 0
输出: BACKUP_PATH=kore/.kore-local-state/backups/.kore-local.yaml.bak-20261125T191126
       sha256 源=备份=ee9e40b8f7aa3b34b759d0103b60fe7c1782fca2e412ccd90b88ffa735f9a413
       cmp=identical；mtime 两边同为 2026-11-25 19:10:43 +0800；git check-ignore 命中 .gitignore:61:.kore-local-state/
```
> 备份含口令哈希，按运行态资产对待：未进 git、未打印内容、不写进本报告正文。

## 3. 修 index_dir（G-29）

因步骤 1 追加了两行 auth 字段，index_dir 从 :12 漂移到 :14；按**内容唯一匹配**改写（assert count==1），未固定行号硬写：

```text
改前: index_dir: "/home/pt/Work/GolandProjects/kore-plugins/index"   （旧路径不存在）
改后: index_dir: "/home/pt/Work/GolandProjects/kore-pl/kore-plugins/index"（真源，含 plugins.json + .sig）
diff -u 备份 vs 现配置: 仅 index_dir 一行变化，其他字段原样。
改后 sha256: 13c2dafadd49d8455bf93cf3c7ce588c82a1815110bc35bd4aad6f143188ead2
```

## 4. 新二进制构建 + 重启生效（ADR-0056）

**为什么必须换二进制**：运行的是 11-24 旧版，无 `restart` 子命令 / 无 `/api/v1/system/restart` 端点；不换二进制则步骤 4 的自服务重启不可达（返回 501）。方案 §3 已授权「若需要新功能生效必须 make build + 自重启替换」。

```text
命令: GOWORK=off GOCACHE=kore/.tmp/gocache GOMODCACHE=kore/.tmp/gomodcache CGO_ENABLED=0 GOAMD64=v1 GOFLAGS='' \
      go build -trimpath -buildvcs=false -ldflags='-s -w' -o kore/bin/kored.new ./cmd/kored
退出码: 0
输出: sha256(bin/kored.new)=4a9da02ecc027b4f5417a5ba0e35c6433db5e455db7402df851b4b7600321b39；version=kored 0.1.1

root 命令（只走 dsh-root；审计日志只读 FS 告警如实记录）:
  dsh-root bash -c 'install -m 0775 .../bin/kored.new .../bin/kored'  → 退出码 0（输出仅审计告警）
  dsh-root systemctl restart kore.service                          → 退出码 0（输出仅审计告警）
```

- 旧二进制留 `kore/bin/kored.bak-20261125T191200`（sha `d53b6ed5…`），可回滚。
- 未使用 `POST /api/v1/system/restart`（新进程起来后该端点其实可用，confirm-token 带会话=200），因为 swap 本身需要 dsh-root 写 `bin/kored`，若先只重启则仍跑旧 bin、端点 501；用 dsh-root 一次完成 swap+restart 更少一次停机窗口。API 端点经只读探测确认存在（anon 401，带会话 200），未实际提交重启（避免重复停机）。
- healthz：重启后第 1 次探测即 200（30s 预算内）；服务 MainPID 1026600 → 1325614，ActiveState=active，User=root。

## 5. 回读复核（G-29 硬判据，带会话）

```text
命令: curl -s -b "$JAR" http://127.0.0.1:8787/api/v1/system/info
退出码/HTTP: 200
输出: paths.index_dir=/home/pt/Work/GolandProjects/kore-pl/kore-plugins/index  ← 逐字等于新配置值

命令: curl -s -b "$JAR" -w '%{http_code}' http://127.0.0.1:8787/api/v1/store/plugins
退出码/HTTP: 200；条数=24；store 版本 vs 索引版本 diff_count=0（24/24 一致）；无 401/404/500
命令: curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
退出码/HTTP: 200
```
→ G-29 ①②通过；进入安装步骤。

## 6. 升级 15 插件（POST /api/v1/store/install，download:true，串行）

索引 URL/sha 从已验签 `plugins.json` 取，服务端流式校验 sha256；逐条结果（HTTP / code / previous / reload / 实测版本）：

| id | 目标 | HTTP | code | previous | reload | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| app-deploy | 0.4.0 | 200 | OK | 0.3.3 | restarted | ✅ 0.4.0（canary） |
| backup | 0.5.2 | 200 | OK | 0.5.1 | restarted | ✅ 0.5.2 |
| container | 0.6.0 | 200 | OK | 0.5.5 | restarted | ✅ 0.6.0 |
| cron | 0.9.0 | 200 | OK | 0.7.0 | restarted | ✅ 0.9.0 |
| db-postgres | 0.4.0 | 200 | OK | 0.3.4 | restarted | ✅ 0.4.0 |
| firewall | 0.3.0 | 200 | OK | 0.2.6 | restarted | ✅ 0.3.0 |
| integrity | 0.6.0 | 200 | OK | 0.5.1 | restarted | ✅ 0.6.0 |
| monitor | 0.5.0 | 200 | OK | 0.3.1 | restarted | ✅ 0.5.0 |
| runtime-node | 0.3.0 | 200 | OK | 0.2.5 | restarted | ✅ 0.3.0 |
| runtime-php | 0.3.0 | 200 | OK | 0.2.2（无 current） | restarted | ✅ 0.3.0（首次装上） |
| runtime-python | 0.4.0 | 200 | OK | 0.3.2 | restarted | ✅ 0.4.0 |
| site | 0.8.1 | **400** | **E_INVALID** | — | — | ❌ 仍 0.4.4 |
| ssh-guard | 0.4.0 | 200 | OK | 0.3.1 | reloaded | ✅ 0.4.0 |
| ssl | 0.8.0 | 200 | OK | 0.7.1 | restarted | ✅ 0.8.0 |
| waf | 0.5.1 | 200 | OK | 0.4.5 | restarted | ✅ 0.5.1 |

**site 失败原文**：
```text
HTTP 400 {"code":"E_INVALID","message":"安装失败","detail":"installer: 包校验失败: info.json 校验失败：E_INVALID: 声明了 root_actions 必须同时设置 requires_root:true"}
```
只读核验：`../kore-plugin-site/dist/site-0.8.1.tar.gz` 内 `info.json` 确有 `root_actions`、`requires_root` 缺失（None），与索引 sha 一致（未篡改包）——**插件包自身缺陷**。site 失败后继续装完剩余 3 项（失败为逐项隔离、不影响其它插件），安装中 healthz 全程 200。

## 7. 最终复核

| 判据 | 结果 |
| --- | --- |
| 逐插件版本 | installed 24 条 vs 索引 24 条：mismatch=1（site want 0.8.1 got 0.4.4），MATCH=23/24；本轮 15 目标达成 14/15；原 9 项已同步项未被破坏 |
| healthz | 3/3 探测 200 |
| store plugins | HTTP 200，24 条，版本 == 索引（diff=0），无错误码 |
| 索引验签 | `bash kore-plugins/scripts/validate-index.sh` exit 0：schema/sha/单调/market 逐字节/ed25519 全部 OK |
| 二进制 | sha256(disk bin/kored) == sha256(bin/kored.new) == `4a9da02e…`；旧版备份 `bin/kored.bak-20261125T191200` sha `d53b6ed5…`；运行 exe 因沙箱 PID namespace 隔离无法直接读 `/proc/<pid>/exe`，以 dsh-root `systemctl show MainPID=1325614` + swap 后 healthz 恢复 + 端点新特性存在（confirm-token 200 而非 501）佐证新 bin 已生效 |
| 凭据 | 凭据文件 0600、gitignore 命中、明文未入任何报告/日志；`must_change_password=true` 已写入配置（运行 manager 未加载该闸门，故未强制在线改密；如需启用请 SIGHUP 或重启后在线改密一次） |
| G-29 声明 | **本轮改过主实例运行态配置：是** —— index_dir 永久修复一次（备份 `kore/.kore-local-state/backups/.kore-local.yaml.bak-20261125T191126`，已重启、已复核）；另原子写入凭据哈希/标志，凭据文件 gitignore。回切条件：若需恢复旧路径，`cp -a <backup> kore/.kore-local.yaml` → `dsh-root systemctl restart kore.service` → 重跑 §5 复核（注意旧路径不存在会导致商店 401/空，非推荐回退） |

## 8. 未做 / 边界

- 未 push、未 tag、未触发任何 CI（GitHub/Gitea 均未触碰）。
- 未改插件代码 / 索引 / 版本 / dist；site 包缺陷留给插件 owner。
- 未建用户、未 `chown -R`、未删数据；root 操作仅 dsh-root 两条（swap + restart），命令与退出码见 §4。
- 一次性 sh 脚本已删（用户规则：工作区不留临时脚本）；证据数据 `.tmp/install-results.tsv` 为 .tmp/ 下（gitignore）仅本轮记录用，不进提交。

## 9. 后续建议（不在本写域）

1. `kore-plugin-site` owner：在 `info.json` 补 `requires_root: true`（与 `root_actions` 配套），bump 0.8.2 重发 dist + 重签索引；之后本流程只需重跑 site 一条 `store/install` 即可闭环。
2. 如需让 `must_change_password` 闸门真正生效：SIGHUP 或重启后在线 `POST /api/v1/auth/password` 改密一次（凭据文件会被内核消费删除），本报告不代做（避免把一次性口令改掉后影响其它并发卡）。
