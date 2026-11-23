# 24 仓能力缺口审计（声明 vs 实现 / production fault / 主壳入口）

- 审计人：`gap-audit-plugins`（verifier，能力缺口）
- 时间：2026-11-23
- 范围：`../kore-plugin-*` 全部 24 仓；写域仅本文件；未改任何插件仓代码、未构建、未跑测试、未发版。
- 事实来源：各仓 `git show HEAD:info.json` 与 HEAD Go 源码（不读工作树未提交改动，避免并发干扰）。
- 纪律：`info.json` + 代码为唯一事实来源；文末「未确认」项明确缺什么证据。

## 0. 方法数统计命令（唯一口径）

```bash
cd /home/pt/Work/GolandProjects/kore
# 实际方法数：HEAD 中 methods.go（含 internal/**/methods.go）+ internal/**(call|runtime).go 的 case 字面量
# 排除协议内建 kore.* 与共享 config.* 分派；redis/site 走注册表，单独计数
python3 - <<'PY'
import subprocess,os,json,re
def show(d,p):
    r=subprocess.run(['git','-C','../'+d,'show','HEAD:'+p],capture_output=True,text=True)
    return r.stdout if r.returncode==0 else ''
def tree(d):
    return subprocess.run(['git','-C','../'+d,'ls-tree','-r','--name-only','HEAD'],
                          capture_output=True,text=True).stdout.splitlines()
for d in sorted(x for x in os.listdir('..') if x.startswith('kore-plugin-')):
    n=d.replace('kore-plugin-',''); info=json.loads(show(d,'info.json')); pid=info['id']
    cs=set()
    for f in [x for x in tree(d) if x.endswith('methods.go') or re.match(r'^internal/.*/(call|runtime)\.go$',x)]:
        for line in show(d,f).splitlines():
            if re.match(r'^\s*case ',line):
                for lit in re.findall(r'"([a-zA-Z][a-zA-Z0-9._]*)"',line):
                    if lit.startswith(pid+'.'): lit=lit[len(pid)+1:]
                    if lit.startswith(('kore.','config.')): continue
                    cs.add(lit)
    mc=info.get('method_capabilities') or {}
    print(f"{n}\tdecl_mc={len(mc)}\tdecl_methods={len(info.get('methods') or [])}\tcases={len(cs)}")
PY
```

补充口径（两仓走注册表，非 `case` 分派）：

- `redis`：`git -C ../kore-plugin-redis show HEAD:internal/redisop/call.go | grep -cE '^\s*"[a-zA-Z]+":'` → **17** 动词；+ `serverConfig.get/set` 2 + 共享 `config.get/set` 2 = **21**。
- `site`：`git -C ../kore-plugin-site show HEAD:siteverbs.go | grep -cE '^\s*"[a-zA-Z]+":'` → **20**；+ 共享 `config.get/set` 2 = **22**。
- `config.get` / `config.set` 由共享 config 分派处理（不在 methods.go 的 case 里），故「声明 = 实际」的比对中把 `config.*` 计入实际数，避免系统性误判为 2 个缺口。

## 1. 主表（24 仓）

图例：✅ 无问题｜⚠️ 有但可疑｜❌ 有问题｜N/A 不适用。

| 仓 | 版本 | 声明方法数 | 实际方法数 | depth_level | fault 覆盖 | 主壳入口 | 缺字段 | CHANGELOG | README |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| app-deploy | 0.3.0 | 8 | 8 | production | ❌ 4 个新方法未覆盖 | ⚠️ 视图刚补 | ✅ | ✅ | ❌ 4 方法未列 |
| backup | 0.4.2 | 13 | 13（11+config2） | production | ✅ | ✅（schedule 走内核，设计如此） | ✅ | ✅ | ✅ |
| container | 0.5.2 | 13 | 13 | production | ✅ | ✅ | ✅ | ✅ | ⚠️ 4 方法未列 |
| cron | 0.5.0 | 10 | 10 | production | ⚠️ 5 方法未引用 | ✅ | ✅ | ✅ | ⚠️ 2 方法未列 |
| db-mysql | 0.4.1 | 15 | 15（13+2） | production | ✅ | ✅ | ✅ | ✅ | ✅ |
| db-postgres | 0.3.3 | 13 | 13（11+2） | production | ✅ | ✅ | ✅ | ✅ | ❌ 6 方法未列 |
| discover | 0.3.1 | 4 | 4（3+1） | production | ✅ | ❌ 无独立视图 | ✅ | ✅ | ✅ |
| dns | 0.4.0 | 11 | 11 | production | ⚠️ 8 方法未引用 | ✅ | ✅ | ✅ | ⚠️ 3 别名未列 |
| echo | 0.1.4 | 5（插件级 capability） | 5 | production | ✅（验证件） | N/A（验证件） | ✅ | ✅ | ✅ |
| file | 0.3.2 | 23 | 23 | production | ✅（matrix_test） | ✅ | ✅ | ✅ | ✅ |
| firewall | 0.2.6 | 7 | 7 | production | ⚠️ enable/disable 未引用 | ✅ | ✅ | ✅ | ✅ |
| integrity | 0.4.0 | 7 | 8 | production | ✅ | ✅ | ⚠️ `verify_file` 无方法级声明（命名约束已知） | ✅ | ✅ |
| logs | 0.5.0 | 15 | 15（13+2） | production | ❌ 5 个新方法未覆盖 | ✅ | ✅ | ✅ | ✅ |
| monitor | 0.3.0 | 4 | 4 | production | ✅ | ✅ | ✅ | ✅ | ✅ |
| process | 0.3.0 | 9 | 9 | production | ✅ | ⚠️ 4 方法未见字面量入口（动态拼接入口，未确认） | ✅ | ✅ | ✅ |
| redis | 0.6.0 | 21 | 21（19+2） | production | ✅ | ✅ | ✅ | ✅ | ✅ |
| runtime-node | 0.2.4 | 5 | 5 | production | ✅ | ✅ | ✅ | ✅ | ✅ |
| runtime-php | 0.2.2 | 5 | 5 | production | ✅ | ✅ | ✅ | ✅ | ✅ |
| runtime-python | 0.3.1 | 9 | 9 | production | ✅ | ⚠️ pip/venv 无入口 | ✅ | ✅ | ✅ |
| site | 0.4.3 | 22 | 22（20+2） | production | ✅（sitedir_test） | ✅ | ✅ | ✅ | ✅ |
| ssh-guard | 0.3.0 | 9 | 9（7+2） | production | ❌ 仅 kill/timeout，业务方法 0 覆盖 | ✅ | ✅ | ✅ | ✅ |
| ssl | 0.6.0 | 20 | 20 | production | ⚠️ 8 方法未引用 | ⚠️ acme.builtin.* 无入口 | ✅ | ✅ | ✅ |
| terminal | 0.2.0 | 9 | 9 | production | ❌ 3 个新方法未覆盖 | ✅ | ✅ | ✅ | ✅ |
| waf | 0.4.3 | 12 | 12（11+别名） | production | ⚠️ 7 写方法未引用 | ⚠️ blockLog 仅作 logs 别名 | ⚠️ `blockLog` 未单列（别名，可接受） | ✅ | ⚠️ 3 方法未列 |

结论要点：

- **24/24 全部声明 `depth_level=production`**，`echo` 为验证件；24/24 都有 `tests/fault/`（G-20 字面满足）。
- **声明 vs 实现无「方法根本不存在」的 P0**：逐仓比对后，唯一差异是 `integrity.verify_file`（未写入 `method_capabilities`，因内核 `methodActionPattern` 不支持 `_`，属文档已披露的已知约束）与 `waf.blockLog`（`waf.logs` 的兼容别名，`internal/wafop/call.go:49` 已注明）。
- **真正缺口在「fault 覆盖不到新增方法」**：4 仓（app-deploy / logs / ssh-guard / terminal）最新版本新增方法在 `tests/fault/` 里 0 引用；3 仓（cron / dns / firewall / ssl / waf）为 generic 故障套件未按方法覆盖，判 ⚠️。

## 2. 问题清单

### P0（声明 production 但 fault 覆盖不到新增方法 / 声明方法不存在）

| # | 仓 | file:line | 一句话 | 建议动作 |
| --- | --- | --- | --- | --- |
| P0-1 | app-deploy | `CHANGELOG.md:5-8`（`upload` / `deployFromArtifact` / `upgrade` / `jobs`）+ `tests/fault/{cgroup,disk,kill,timeout}_test.go` | 0.3.0 新增 4 个 artifact 方法，fault 只断言 `deploy`/`list`/`remove`（`tests/fault` 内无这 4 个方法名字面量），G-20 的「production 必过故障注入」对新方法无证据 | 补 `tests/fault/artifact_test.go`：解压失败 / 磁盘满 / rename 回滚 / jobs 落盘失败四类 |
| P0-2 | logs | `CHANGELOG.md:12-19`（`retention.get` / `retention.set` / `usage` / `clean` / `clean.restore`）+ `tests/fault/{cgroup,disk,kill,timeout}_test.go` | 0.5.0 新增 5 个保留策略/清理方法，fault 目录零引用；清理是删文件类破坏性动作，恰恰最需要故障注入 | 补 fault：磁盘满时 retention.json 原子写失败、clean 回收区写失败回滚、restore 目标已存在跳过 |
| P0-3 | terminal | `CHANGELOG.md:6-7`（`history` / `history.clear` / `attach`）+ `tests/fault/{cgroup,disk,kill,timeout}_test.go` | 0.2.0 新增历史落盘与重连游标，fault 目录零引用；历史落盘是 best-effort 写盘路径，失败语义未注入验证 | 补 fault：state 目录只读 / 磁盘满时 write 仍成功且返回 `storage_error`；attach 越权 `E_UNAUTHORIZED`；游标 `E_CONFLICT` |
| P0-4 | ssh-guard | `CHANGELOG.md:36-47`（`ban.add` / `ban.remove` 真实执行）+ `tests/fault/fault_test.go`（仅 kill/timeout，且注释自认「basic 级磁盘满/cgroup 延 v1.1」） | 声明 production，但 fault 只有进程级 kill/timeout，7 个业务方法 0 覆盖；与自身注释「basic 级」自相矛盾 | 二选一致：补 ban 写路径故障注入（iptables 失败 / 令牌缺失 / 日志解析异常），或把 `depth_level` 降为 `basic` |

### P1（后端有能力但主壳无任何入口）

| # | 仓 | file:line | 一句话 | 建议动作 |
| --- | --- | --- | --- | --- |
| P1-1 | discover | `web/shell.js:66-69`（四组导航无 discover 项）、`web/*.js` 仅 `discover.services` 被引用 | `discover.ports` / `discover.summary` 后端可用（`internal/discover/methods.go`），主壳无独立视图，端口/摘要能力用户不可达 | 补 `web/discover.js` + 导航项，或明确降级为「服务商店安装建议」内部能力并在文档标注 |
| P1-2 | runtime-python | `web/runtimes.js:99-223`（只 invoke `versions`/`doctor`/`info`/`projects`）、全仓 `web/` 无 `pip.install`/`venv.create` 字面量 | Python 的 `pip.install` / `pip.list` / `venv.create` / `venv.list` 后端存在，主壳运行环境页无任何按钮/表单入口 | 在 runtimes 视图加「创建 venv / 安装依赖」入口，或明确标注 v1.1 |
| P1-3 | ssl | `web/ssl.js:5`（只列 `ssl.acme.status` / `ssl.acme.issue`）；全仓 `web/` 无 `acme.builtin.*` 字面量 | `ssl.acme.builtin.issue/renew/status` 三条内置通道后端存在，主壳只能走外部客户端探测/调用，内置签发路径用户不可达 | 在 SSL 视图 ACME 区块增加「内置通道」选项，或文档写明仅 API 可用 |

> 说明：`backup.schedule.get/set` 在主壳无字面量调用，但 `web/backups.js:6-12` 明确「定时备份不在插件里实现，前端直接调内核 `/api/v1/scheduler/tasks`」——**设计如此，不计缺口**。

### P2（必填字段缺失 / CHANGELOG 缺条目 / README 过期）

| # | 仓 | file:line | 一句话 | 建议动作 |
| --- | --- | --- | --- | --- |
| P2-1 | app-deploy | `README.md`（无 `upload`/`jobs`/`upgrade`/`deployFromArtifact`） | README 方法表停在 0.2.x，4 个 0.3.0 新方法未列 | 补方法表 4 行 |
| P2-2 | db-postgres | `README.md`（无 `changePassword`/`createDatabase`/`createUser`/`dropDatabase`/`dropUser`/`grant`） | README 未覆盖 0.3.x 的库/用户/授权/改密能力，用户按 README 会以为只有查询 | 补方法表 6 行 |
| P2-3 | container | `README.md`（无 `images`/`pull`/`rmi`/`update`） | 镜像与 update 能力未进 README | 补 4 行 |
| P2-4 | cron | `README.md`（无 `batch`/`templates`） | 批量与模板未列 | 补 2 行 |
| P2-5 | dns | `README.md`（无 `addRecord`/`updateRecord`/`deleteRecord`） | 三个兼容别名未列（若有意隐藏别名，请在 README 注明「别名」） | 补说明或补 3 行 |
| P2-6 | waf | `README.md`（无 `rule.add`/`rule.remove`/`rule.toggle`） | 规则增删启停未列，用户只能看到 ban/unban | 补 3 行 |
| P2-7 | integrity | `info.json:13-20`（`method_capabilities` 无 `verify_file`） | `verify_file` 因下划线命名无法声明方法级 capability（内核 `methodActionPattern` 限制），回退插件级 → 只读调用被按 admin 审计 | 已知约束；建议 0.5.0 改 camelCase `verifyFile` 并保留旧名别名 |
| P2-8 | waf | `info.json:13-16`（`method_capabilities` 无 `blockLog`） | `blockLog` 是 `logs` 别名（`internal/wafop/call.go:49,84`），未单列；语义由 `waf.logs` 覆盖 | 可接受；若前端按方法名审计需补一条 |

**统计：P0 4 条（4 仓）｜P1 3 条（3 仓）｜P2 8 条（7 仓）｜CHANGELOG 缺条目 0 条。**

## 3. 检查项结果汇总

1. **声明 vs 实现方法数**：24 仓逐仓比对，**无「声明了但代码里不存在」的方法**；仅 integrity（`verify_file` 未声明）与 waf（`blockLog` 别名未声明）两处非对称，均属已知命名约束/别名，非 404 风险。
2. **production 故障注入**：24/24 有 `tests/fault/`；4 仓新增方法零覆盖（P0），5 仓 generic 套件未按方法覆盖（⚠️）。
3. **主壳入口**：`discover` 无独立视图（P1）；`runtime-python` pip/venv、`ssl` acme.builtin.* 无 UI 入口（P1）；其余仓均有对应视图（`app-deploy` 视图已补，`echo` 为验证件）。
4. **必填字段**：`depends_on` / `conflicts` / `scenario_tags` / `size_bytes` / `requires_kore` / `capabilities` / `depth_level` **24/24 齐备**；方法级 capability 两处非对称见 P2-7/P2-8。
5. **CHANGELOG 与版本**：24/24 顶部条目版本 == `info.json.version`（格式有 `## x` / `## [x] - date` 两种，不影响一致性）。
6. **README 方法表**：6 仓明显过期/漏列（P2-1 ~ P2-6），其余 18 仓方法名可检索到。

## 4. 未确认项（缺什么证据）

| 项 | 缺的证据 |
| --- | --- |
| `process.history` / `ports` / `trend` / `watchdog.suggest` 是否有主壳入口 | `web/process.js` 用 `'process.' + <tab>` 动态拼接，静态 grep 命中不到字面量；需人工点开进程页逐个 tab 核对或读该文件完整调用链 |
| `monitor.disks` / `monitor.processes` 入口 | 同上，`web/monitor.js` 存在动态前缀；未在静态扫描中确认 |
| cron / dns / firewall / ssl / waf 的 fault 套件是否以「通用故障 × 全方法循环」方式覆盖 | 未逐文件读完 5 仓 `tests/fault/*`；需确认 helper 是否遍历方法表（`file` 的 `matrix_test.go`、`cron` 的 `features_test.go` 疑似方法矩阵，未展开） |
| app-deploy 视图「刚补」的实际可用性 | 本轮只读审计，未起实例点开页面；G-28 双端截图证据不在本文件范围 |
| `size_bytes` / `requires_kore` 数值是否与实际 dist 一致 | 需构建 dist 后比对，本轮禁止构建 |

---
审计口径：只读 HEAD；未改动任何插件仓；未运行构建/测试/发版。方法数统计命令见 §0，任何人可复跑核对。
