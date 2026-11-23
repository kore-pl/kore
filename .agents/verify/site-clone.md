> 元信息: 2026-11-23T18:37+08:00 · 执行者 kore-impl-container-view（implementer）· 只截图不改代码（UI = `aa28870`，sites.js +115）· 隔离实例 `127.0.0.1:18879`（`--config /tmp/kore-site/config.yaml`，state/run/log 全在 `/tmp/kore-site`）· 插件 site **0.4.0**（本地包 sha `4f478ff66194`/1575333 与已签索引一致，离线安装）· 主实例 8787 零写入 · task-37 · 报告 ≤70 行

# site.clone 克隆入口 G-28 双端截图

## 0. 结论与降级声明

**降级为「面板渲染截图」，未执行真机克隆**（lead 允许的第二档）。原因不是起不了 nginx，而是**隔离写边界**：site 插件默认 `host_conf_dir=/etc/nginx/conf.d`（`kore-plugin-site/configapi.go:71-73`），该目录是**主实例 nginx 容器共享的宿主目录**（内有 `kore-site-demo.kore.test.conf` 等主实例站点），且 `nginx_mode=docker` 会 `docker exec` reload 共享容器——隔离实例一旦真克隆就会写共享目录 + 重启主实例的 nginx，直接违反 G-29。故本轮**只读**打开既有站点详情渲染克隆表单，不点「克隆站点」提交。

## 1. 截图证据（`file` 实测 + 色标帧校验 attempt=1）

| 文件 | `file` 实际宽高 | sha256 前16 | 覆盖内容 |
| --- | --- | --- | --- |
| `site-clone-desktop-01.png` | **1440 x 3019**（full-page） | `ae1bfb92f668d4ce` | 站点详情 `demo.kore.test`（运行中/已启用/根目录/端口80/SSL/伪静态/反代/重定向1条/vhost 路径/在插件清单内/站点目录存在/运行状态）+ **克隆站点面板**：新域名输入框预填 `demo-clone.kore.test`、「同时复制站点文件（默认关闭）」勾选框**未勾选**、说明文案、「克隆站点」主按钮 |
| `site-clone-mobile-01.png` | **390 x 844** | `cb2418db1948209a` | 手机端同页：卡片式堆叠、**横向溢出 0**、表单控件 ≥44px |

DOM 断言（拍摄前回读，`/tmp/kore-site/shots.json` 已随实例删除，关键值抄录）：站点列表 3 条（`demo/live/blog.kore.test`）；克隆面板 `{title:克隆站点, meta:复制当前站点的全部配置到新域名（做测试环境）, domain:demo-clone.kore.test, copyRootChecked:false, submit:克隆站点}`；`page_errors_total=0`；console 6 条全为预期（favicon 404、首帧 401、隔离实例未装 monitor/ssl/discover/site-外插件的概览探测 404）。建议域名的自动预填逻辑（`src.example.com → src-clone…`）在真机上得到验证。

## 2. 产品定位自评（G-28 三问）

**① 本页解决什么问题**：上线前想验一版配置改动，传统做法是手工复制 vhost、改域名、改根目录、reload——四步且容易把源站改坏。克隆面板把这四步收成一个表单：源站点自动带出、新域名自动建议（`demo.kore.test → demo-clone.kore.test`）、新目录自动推导、**复制文件默认关闭**（先只验配置，零文件风险），点一次「克隆站点」出一个可回滚的测试站。

**② 与宝塔/1Panel 的差距**：它们的克隆/复制站点常带**一键切换运行版本、克隆到子目录+子域名通配、数据库一并克隆、克隆后直接预览**；本页克隆只覆盖 nginx vhost 配置（+可选静态文件复制），**不含数据库、不含 SSL 证书迁移、无克隆任务列表/一键回滚 UI**（回滚靠既有 `.bak.*` 备份文件）。另外它们能可视化编辑克隆后的每一条规则，本页克隆完要回详情页逐项看。

**③ 当前是「可用」还是「占位」**：**面板可用、执行链未在本轮取证**——表单渲染、预填、默认值、说明文案、双端响应式全部真机验证（截图 + DOM 断言，Runtime 异常 0）；但**真机 `site.clone` 调用与克隆结果未执行**（原因见 §0 的共享目录边界，属环境约束非代码缺陷）。边界如实声明：`copy_root=true` 的文件复制路径、`E_CONFLICT` 域名冲突等错误分支只在代码与既有测试中存在，本轮未截图覆盖。

## 3. G-29 / 提交

**本轮未改动主实例运行态配置**：`.kore-local.yaml`/`.kore-local-state`/`.kore-local-run` 零写入；**未对 `/etc/nginx/conf.d` 做任何写入**、未 docker exec 任何容器、未调用 `site.add`/`site.clone`（只用了 `site.list`/`site.detail` 只读方法）；8787 仅 `ss` 只读探测。隔离实例 `/tmp/kore-site` 验证完即删。索引为已验签 `kore-plugins/index`，本地包 sha 与索引一致走离线 `package_path` 安装，未开 `allow_unsigned`。提交：`docs(verify): site.clone G-28 双端截图`（本报告 + 2 张截图，不 push、不碰代码）。
