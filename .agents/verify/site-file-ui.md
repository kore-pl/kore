> 元信息: 2026-11-23T20:02+08:00 · 执行者 kore-impl-container-view（implementer）· 只截图不改代码（site = `215cac1`，file = `94f4783`）· 隔离实例 `127.0.0.1:18883`（`--config /tmp/kore-a65/config.yaml`，state/run/log/file-root 全在 `/tmp/kore-a65`，`KORE_FILE_ROOT` 指向隔离目录）· 插件 site **0.4.2**（`a467c9dec113`）+ file **0.3.2**（`e4079c3c9382`），本地包 sha 与已签索引一致、离线安装 · 主实例 8787 零写入 · task-65 · 报告 ≤70 行

# site 流量/访问保护 + file 在线编辑 G-28 双端截图

## 0. 结论

4 张截图齐（`file` 实测宽高见下），色标帧校验 attempt 全 =1，浏览器 `page_errors_total=0`。**file 在线编辑 = 真机取文件真内容**（隔离根下 `file.write` 造的 `hello.txt` → 预览 → 点「编辑」→ textarea 载入真内容 + 保存/取消栏，拍前 DOM 断言 `buttons=['保存','取消']`）；**site 流量统计 = 空态降级截图**（`site.traffic` 真机返回 `available:false / reason:no_log_file`——nginx 跑在容器里、宿主默认路径没有 access log），面板、原因与补救指引完整渲染；**访问保护 = 表单与说明渲染**（插件无「读取是否开启」接口，状态按设计显示「未确认」）。

## 1. 截图证据（`file` 实测 + 色标帧校验 attempt=1）

| 文件 | `file` 实际宽高 | sha256 前16 | 覆盖内容 |
| --- | --- | --- | --- |
| `site-traffic-desktop-01.png` | **1440 x 3311**（full-page） | `85af9ff30037a30b` | 站点详情 `demo.kore.test`：**流量统计**面板（空态：「未开启访问日志，或在默认路径找不到日志文件」+ `access_log …` 补救指引 + 已尝试路径 + 日志权限提示）+ **访问保护**面板（说明「密码只保存为加盐哈希，本页面不会显示也不会回传」、用户名/密码 ≥8 字符、「启用密码保护/关闭密码保护」两按钮、「未确认」状态与原因）+ 既有详情字段与克隆面板 |
| `site-traffic-mobile-01.png` | **390 x 844** | `745039872f2d7723` | 手机端同页，**横向溢出 0**、控件 ≥44px |
| `file-edit-desktop-01.png` | **1440 x 900** | `00ee940e20058faa` | 文件视图 → `hello.txt` 预览 → **编辑态**：`textarea.files-editor` 载入 4 行真内容（首行 `hello kore file editor`）+ 保存栏「保存/取消」+「保存会用乐观锁校验；被其他会话改过会提示刷新」 |
| `file-edit-mobile-01.png` | **390 x 844** | `5a93eec67f3110f8` | 手机端编辑态，横向溢出 0 |

DOM 断言（拍前回读，`shots.json` 随实例删除，关键值抄录）：`traffic` 面板文本含 `no_log_file` 补救文案；`protection` 面板含「未确认…以设置/关闭的成功提示为准」；`editor_shot01={ta:true, head:'hello kore file editor', buttons:['保存','取消']}`；`page_errors_total=0`；console 6 条全为预期（favicon 404、首帧 401、隔离实例未装 monitor/ssl/discover 的概览探测 404）。

**过程记录（如实）**：第一轮 `编辑态` 断言通过但保存栏读到空（时序竞态），加了「拍前确认保存栏，不在就重点编辑」的守护后重拍定稿——两轮 desktop sha 一致，说明首拍实际已是编辑态，空值是选择器读早了。

## 2. 产品定位自评（G-28 三问）

**① 各解决什么问题**：site 侧——建完站想知道「有没有人访问、被刷了没」，流量统计把 access log 解析成汇总表 + Top 路径/Top IP（不用登机 tail 日志）；访问保护给单站点加一层浏览器 Basic 认证，公开目录（如 `/.well-known` 之外的后台页）不再裸奔，密码只存加盐哈希。file 侧——改个配置/文案要下载-编辑-上传三步，现在预览区点「编辑」直接改，乐观锁防并发覆盖。

**② 与宝塔/1Panel 的差距**：它们的流量统计是图表化（时序曲线、PV/UV 趋势、按天留存）且通常带 WAF/CC 防护联动；本页是**日志文件级汇总表、无历史留存**。访问保护它们常支持多用户/多路径规则/白名单 IP，本页是**单域名一套账密**。文件编辑它们有差异对比/多 tab/权限编辑器，本页是单文件 textarea + sha 乐观锁。

**③ 当前是「可用」还是「占位」**：**file 编辑：可用（真机取证）**——真文件、真读写链路入口、双端渲染、异常 0（本轮未点「保存」，避免动共享状态；乐观锁分支有既有测试覆盖）。**site：面板可用、数据侧空态降级**——`site.traffic` 真机调用返回 `no_log_file`（nginx 容器日志不在宿主默认路径），截图即该空态与补救指引，**未取得真实流量行**；**访问保护：仅表单渲染取证**——插件无状态读取接口（面板已如实标注「未确认」），本轮**未提交**启停（会写共享 vhost 配置，G-29 边界）。

## 3. G-29 / 提交

**本轮未改动主实例运行态配置**：`.kore-local.yaml`/`.kore-local-state`/`.kore-local-run` 零写入；未对 `/etc/nginx/conf.d` 写入、未点访问保护启停、未点文件保存；`KORE_FILE_ROOT` 指向隔离目录 `/tmp/kore-a65/file-root`（测试文件只存在隔离根内）；站点列表为共享 vhost 的**只读发现**；8787 仅 `ss` 只读探测。隔离实例 `/tmp/kore-a65` 验证完即删。索引为已验签 `kore-plugins/index`，两包离线 `package_path` 安装，未开 `allow_unsigned`。提交：`docs(verify): site 流量/访问保护与 file 在线编辑 G-28 双端截图`（本报告 + 4 张截图，不 push、不碰代码）。
