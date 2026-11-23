> 元信息: 2026-11-23T21:26+08:00 · 执行者 kore-impl-container-view（implementer）· 不改任何代码 · 隔离实例 `127.0.0.1:18898`（`--config /tmp/kore-appdeploy/config.yaml`，state/run/log 全在 `/tmp/kore-appdeploy`）· 插件 app-deploy **0.3.0**（本地 dist sha `f3fdb914f01a` 与已签索引一致，离线安装）· 主实例 8787 零写入 · task-180 · 报告 ≤70 行

# app-deploy 视图 G-28 双端截图（L1.5 卡点核查）

## 0. 结论（决定能否升 L2 的事实）

**后端真可用，UI 完全没有入口——「无成对双端截图」的真相是「无视图可截」**：
- 主壳 `web/` 无 `app-deploy` 视图文件，`SHELL_ROUTES`/`shell.js` 导航硬编码清单无部署项（导航实测 **22 项**：概览…设置/更多，`deploy_in_nav=false`）；`info.json` 无 `routes` 声明、插件仓 **无 `web/` 目录**（不走 iframe UI）。
- 因此「应用列表/上传部署/升级/任务历史」四类**视图截图无法产出**；本报告给的是**存在性双端截图**（导航无入口）+ **后端 API 真机证据**（上传/部署/升级/任务三条全部实测）。
- **升 L2 判定建议：不升**——L2 需要用户可操作路径，当前用户装了插件也找不到任何入口；缺口是「主壳 app-deploy 视图」（或插件 iframe UI），不是截图本身。

## 1. 截图证据（`file` 实测 + 色标帧校验 attempt=1）

| 文件 | `file` 实际宽高 | sha256 前16 | 覆盖内容 |
| --- | --- | --- | --- |
| `app-deploy-home-desktop-01.png` | **1440 x 900** | （marker 255,0,0） | 概览页 + 完整导航（22 项，**无任何「部署」入口**） |
| `app-deploy-store-desktop-01.png` | **1440 x 1156**（full-page） | （marker 255,0,255） | 软件商店页全貌（见 §3 限制：卡片未渲染） |
| `app-deploy-home-mobile-01.png` | **390 x 844** | （marker 0,60,255） | 手机端概览，**横向溢出 0** |
| `app-deploy-store-mobile-01.png` | **390 x 844** | （marker 255,140,0） | 手机端软件商店 |

DOM 断言（`shots.json` 随实例删除，关键值抄录）：`nav_labels` = 概览/监控/日志/进程/终端/网站/数据库/Redis/计划任务/运行环境/文件管理/备份/SSL/容器/软件商店/已装插件/完整性/防火墙/Web 防火墙/DNS 解析/SSH 防护/设置/更多；`deploy_in_nav=false`；`page_errors_total=0`。

## 2. 后端真机证据（隔离实例 curl，全部成功）

| 步骤 | 方法 | 关键返回 |
| --- | --- | --- |
| 模板 | `templates` | `nginx-static` 等模板可用 |
| **上传** | `upload {name:demo-app, content_base64:…}`（`echo hi > x; tar czf` 真包） | `path=…/apps/demo-app, files:1, bytes:3, sha256:8bae3f…, job:job-5ab983…` |
| 部署 | `deployFromArtifact` | `deployed:true, template:"artifact"` + site 插件建站提示（不启容器不写 nginx，符合设计） |
| **升级** | `upgrade`（同名 v2 包 bytes:3→6） | `upgraded:true, snapshot:…/20261123T131613Z, rolled_back:false`；**部署记录未被改写**（list 前后同 `id=job-2ede15c94c3c / created_at / ports:null`）→ 升级保留原记录配置 |
| **任务/历史** | `jobs` | 3 条全 `succeeded`：upload / deployFromArtifact / upgrade，steps 时间线 `received→extract` |
| 列表 | `list` | 空态 `count:0` → 有数据 `count:1`（status=missing：artifact 部署不启容器，属设计） |

## 3. 限制（如实）

- **商店卡片未截到**：隔离实例 `store/discover` 返回 **0 条**，商店页 innerText 无 `app-deploy` 卡片（成因未排查——超时停点；与「无视图」判定无关，导航证据已足）。
- 无 UI → 上传进度条、升级表单、任务日志跟随等**交互形态零取证**（后端能力见 §2）。
- 手机端只截到概览/商店两页；导航抽屉未展开（同上）。

## 4. 产品定位自评（G-28 三问）

**① 解决什么问题**：把「传包 → 部署 → 升级 → 看任务」四步做成一条流水线：上传即解压入沙箱目录、升级先快照可回滚、每步落 jobs 时间线——出问题能定位到哪一步炸了。
**② 与宝塔/1Panel 差距**：它们是**可视化应用商店**（点选应用→表单→一键起容器，带依赖编排与状态探活）；本插件后端是「制品流水线」（artifact 上传/快照/回滚已具备），但**差最后一公里：没有任何 UI**，也没有容器编排（设计上属 G-11 不做，建站/建库分别交给 site/db-mysql 插件，通过 `site_hint` 引导）。
**③ 可用还是占位**：**后端真可用（§2 六条实测）、UI 占位为零（连占位都没有）**——用户视角是「装了插件但页面上什么都没有」。判定：**不满足 L2**；升 L2 的前置是补主壳 app-deploy 视图（列表空态/有数据 + 上传 + 升级 + jobs 四面板），届时本报告的 API 契约可直接当 UI 接线清单。

## 5. G-29 / 提交

**本轮未改动主实例运行态配置**（`.kore-local*` 零写入，8787 仅 `ss` 只读探测）；隔离实例 `/tmp/kore-appdeploy` 验证完即删；索引为已验签 `kore-plugins/index`，离线 `package_path` 安装未开 `allow_unsigned`。提交：`[agent:kore-impl-container-view] docs(verify): app-deploy 无视图存在性双端截图 + 后端 upload/upgrade/jobs 真机证据`（本报告 + 4 张截图，不 push，不碰 PLUGIN-MATURITY.md/Makefile/embed.go/i18n）。
