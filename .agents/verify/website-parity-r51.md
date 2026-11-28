# 官网 / 对外展示面初步对标（round51，只读核实）

> 状态: verified · 归属: website-parity · 更新: 2026-11-28 · 关联: task-332（用户问题「初步官网就可以对比了吧？」）
> 工具边界：全程只读。竞品页用 `curl` 抓取（`/tmp` 落地即读即弃），**未用 web_fetch**（round21/37 已知被 SSRF 拦截，本轮不重试）；对 1Panel 默认 UA 返回 403（`denied by UA ACL`），改用浏览器式 UA 后 200，下文逐 URL 标注。未安装竞品、未访问登录后台、未碰 8787 / `.kore-local-*` / 宿主、未跑构建测试、未发版。

## 0. 结论先行（事实判断，不夸大）

1. **我方的「官网」不是独立站**：26 个仓库均无 GitHub Pages 配置（无 `CNAME`、无 Pages workflow、无 `.nojekyll`、无 `gh-pages`），`github.com/kore-pl/kore` 的 README 就是事实首页。
2. **现有四类对外展示面**：① README 门户（功能/对比/五锚点/文档导航/快速开始/开源/镜像，但**无一张产品截图**，`kore/README.md:1-251`，图片仅为 badge）；② GitHub Wiki 六页（HTTP 200，但正文为 README 分章摘录，**Configuration 页仅 1132 B、无实质配置内容**）；③ **离线静态文档站** `docs/site/index.html`（54 条索引，零外链、file:// 双击可开，**不是在线站点**）；④ **离线静态插件市场页** `kore-plugins/market/index.html` + `plugins.js`（24 条、6 字段）。
3. **形态不同，只能做「展示面内容维度」的初步对标**：竞品是托管在线官网 + 独立文档中心（BT `www.bt.cn` + `docs.bt.cn`；1Panel `1panel.cn` + `docs.fit2cloud.com/1panel/`）；我方是「README/Wiki 当门面 + 本地离线页面」。因此下文标 **持平 / 我方缺 / 竞品缺 / 无法比**，**不做同口径实测**（不装竞品、不测加载速度/交互、不以静态页面模拟在线站），也不据营销文案判产品能力超越。

## 阶段一：我方展示面只读核实

### ① GitHub Pages / README 门户 / 文档站配置

| 核查项 | 证据（命令 / file:line） | 事实 |
| --- | --- | --- |
| Pages 配置 | `git ls-files '.github/*' 'README*'` → `.github/CODEOWNERS`、`.github/dependabot.yml`、2 个 ISSUE_TEMPLATE、PR 模板、`workflows/ci.yml`、`README.md`；全 26 仓扫 `gh-pages\|^CNAME$\|^\.nojekyll$\|pages` → 零命中 | **无 GitHub Pages**；`.github/workflows/ci.yml:8-9` 仅 `workflow_dispatch`（手动触发，非 Pages） |
| README 首屏是否门户式 | `kore/README.md:1-33`（标题+badge+7 语言切换+一句话定位+「按目的选入口」表+机制差异表），`:34-83` 仓库清单/镜像/能力来源/竞品对比/五锚点，`:99-140` 文档导航+目录结构，`:144-158` 快速开始，`:179-251` 平台/资源/开源/参与 | **是门户式 README**：功能介绍✅ 快速开始✅ 链接✅ 截图❌（全文仅 4 个 badge/协议链接，无 `.png/.jpg` 产品图）；`:144-146` 的快速开始仍写「M1 起可用…M0 占位」，而仓库 CHANGELOG 已到 `[0.1.5]`、实际 `QUICKSTART.md` 可跑——**README 存在状态漂移** |
| 独立文档站框架 | `git ls-files \| grep -Ei 'mkdocs\|docusaurus\|vitepress\|_config.yml\|config.toml'` → 零命中；`docs/README.md:7` 指向 `site/index.html` | **无 mkdocs/docusaurus/vitepress**。有自研**离线**静态文档站三件套 `docs/site/{index.html,docs.js,build-index.sh}`，`build-index.sh:3-5` 原文「零框架…断网 file:// 可开…零 fetch」 |
| 文档站内容量 | `docs/site/index.html:30-34`（标题「kore 文档站」+ 搜索框 + `./docs.js`）、`docs.js` 内嵌 54 条（6 类）；`build-index.sh:24-47` 分类映射、`:87-100` 扫描 `docs/*.md` + `DECISIONS/*.md` | 54 条索引，可离线分类/搜索；**只有链接与状态，无正文预览、无在线 URL** |

### ② GitHub Wiki 六页（curl -I 只读）

```
for p in Home Installation Configuration Usage FAQ Changelog; do
  curl -sS -I -L --max-time 25 -o /dev/null -w 'http=%{http_code} final=%{url_effective}\n' \
    "https://github.com/kore-pl/kore/wiki/$p"; done
```

| 页面 | HTML 状态（curl -I -L） | 原文正文（raw.githubusercontent.com/wiki/kore-pl/kore/<页>.md，重试后） | 完整度判断 |
| --- | --- | --- | --- |
| Home | 200（重定向 1 次 → `/wiki`） | 1806 B，`# kore · 首页` + README 徽章 + 章节导航 11 项 | 导航页，正文靠链接 |
| Installation | 200 | 8927 B，「内容忠实摘自仓库 README.md」+ 开始使用/镜像/目录结构/快速开始/平台/开发约定 | 较完整（README 摘录） |
| Configuration | 200 | 1132 B，原文「README 无独立对应章节；完整说明见 [使用](https://github.com/kore-pl/kore/wiki/Usage) 与 [README]」+ 导航 | **最薄**：无配置内容 |
| Usage | 200 | 9749 B，机制差异/仓库清单/能力来源/五锚点等 README 摘录 | 较完整 |
| FAQ | 200 | 3021 B，资源承诺/参与方式/原则/支持本项目 | 有内容但**多为 README 摘抄，非问答式 FAQ** |
| Changelog | 200 | 1657 B，「当前状态」仍写 M0 文档骨架、M0 进度条满格 | **过时**：与仓库 CHANGELOG `[0.1.5]` 漂移 |

说明：raw 路径首轮对 `Usage`/`FAQ` 出现瞬时 `http=000`（空响应），重试一次均 200；HTML 六页 HEAD 全部一次成功。Wiki 页面每条都自称「内容忠实摘自 README」——是 README 的分章镜像，不是原创产品文档。

### ③ kore-plugins 市场页展示字段

- `kore-plugins/README.md:19-31`：市场页定位「断网可开、零框架、纯静态」，数据由 `build-market.sh` 从 `index/plugins.json` 构建期内嵌（window.KORE_PLUGINS），无 fetch、无外链。
- `kore-plugins/market/index.html:45-54`：`kore 插件市场` 标题 + 副标题「数据来源 index/plugins.json（构建期内嵌）」+ 离线提示 + 搜索框 + footer「本页只做索引展示，不代表信任背书」；`:8-40` 响应式（flex-wrap/auto-fill minmax 280px）、深浅色媒体查询、44px 搜索框。
- `kore-plugins/market/plugins.js:2`：`window.KORE_PLUGINS = [...]`；grep 计数 `id/name/version/depth_level/description/scenario_tags` 各 **24** 次 → 24 条插件，展示 6 字段；无 `download_url`/截图/更新日志/`requires_kore` 展示。摘要多为「名称（场景：…）。详情见对应插件仓库。」（中性模板，非能力描述）。

### ④ 我方形态汇总（诚实口径）

- **不存在**可对外访问的独立官网/Pages 站；公开门面 = GitHub 仓库 README + Wiki。
- `docs/site/` 与 `market/` 是**本地离线 HTML**（file:// 双击打开），设计意图是「零外链、断网可用」，不是网站——把它们叫「官网」会夸大。
- 因此回答用户：「初步官网就可以对比了」——**可以，但只能比『展示面文本』，不能比『站点体验』**；对标对象应为竞品官网的公开文案/导航结构，而不是我方离线页面 vs 竞品在线站的加载/交互。

## 阶段二：竞品官网初步对标（六维）

抓取清单（均只读 GET，含 HTTP 状态 / 最终 URL）：

| 页面 | 请求 | 结果 |
| --- | --- | --- |
| BT 首页 | `curl -L https://bt.cn`（无 UA） | 200，final `https://www.bt.cn/new/index.html`（90,337 B） |
| BT 文档 | `curl -L -A <Chrome UA> https://docs.bt.cn/` | 200，`宝塔面板官方文档` |
| BT 下载/安装页 | `curl -L -A <Chrome UA> https://www.bt.cn/new/download.html` | 200，含安装命令与版本列表 |
| 1Panel 首页 | `curl -L https://1panel.cn/`（无 UA） | **403** `denied by UA ACL = blacklist`；改 `-A <Chrome UA>` 后 200（191,762 B） |
| 1Panel 文档 | `curl -L -A <Chrome UA> https://1panel.cn/docs/` | 200，final `https://docs.fit2cloud.com/1panel/`（53,528 B） |
| 1Panel 版本/动态 | `curl -L -A <Chrome UA> https://1panel.cn/versions.html` / `blog.html` | 200 / 200 |

> 竞品内容均为**官网官方声明**（营销文案、导航结构、文档目录），不是真机行为；未安装、未登录、未实测任何面板功能。下表「我方展示面」给 file:line 或 URL。

### 维度逐项

#### ① 首屏定位语
- **BT**（`https://www.bt.cn/new/index.html`，`<title>`/meta）：「宝塔面板(bt.cn) 简单好用的Linux/Windows服务器运维管理面板」「宝塔(bt.cn)，让运维简单高效。面板支持Linux与Windows系统。一键配置：LAMP/LNMP、网站、数据库、FTP、SSL」；正文首屏「宝塔，安全高效的服务器运维面板 / 全球超2000万台服务器安装，近300万注册用户…」
- **1Panel**（`https://1panel.cn/`，title/meta）：「1Panel - 现代化、开源的 Linux 服务器运维管理面板」「1Panel 是现代化的开源 Linux 服务器运维管理面板，同时也是新一代的 AI 服务器管理面板…一站式服务器管理能力」；正文「服务器管家 · 使用 1Panel 轻松管理应用」。
- **我方**（`kore/README.md:11`）：「Kore 是极简内核驱动、插件定义能力、资源零侵占、完全归属使用者的服务器运维基础底座——一个只做调度的薄壳内核，而不是一个功能面面俱到的大面板」；`:65` 补「22 项能力域——12 生产级/8 基础级/6 明确不做」。
- **判定**：**持平**（都有清晰一句定位；我方更强调架构取舍，竞品更强调易用/AI）。差异是话语体系不同，不构成谁优。

#### ② 功能展示方式
- **BT**（首页正文）：六个编号块「01. 快速创建/管理网站 … 06. AI智能运维」，每块配一句说明；另有产品矩阵（宝塔Linux面板/Windows面板/堡塔云WAF/…）与安全产品分区。
- **1Panel**（首页正文）：「强大的功能特性」四段（AI 管理/高效可视化运维/快速建站部署/企业级安全和备份）+「丰富的应用商店」244 个应用分 16 类（AI 31、建站 9、数据库 24…）。
- **我方**：`kore/README.md:26-32` 机制差异三维表、`:60-75` 能力来源/竞品对比表、`:77-85` 五锚点量化表；`kore-plugins/market/index.html:74-93` 卡片展示每插件 name/id/version/depth_level/description/tags（24 条）。**无截图**（README 无 `.png/.jpg`，市场页无缩略图）。
- **判定**：**竞品更强（我方缺截图与场景化演示）**；文字表格与卡片列表属于不同展示范式，不是同口径可比。市场页有 6 字段卡片/搜索/等级标，属**基础持平**（但只展示索引，不展示功能效果）。

#### ③ 快速开始引导
- **BT**（`https://www.bt.cn/new/download.html`）：「简单 4 步，完成宝塔面板的安装与配置 / 通过SSH连接您的服务器…」+ 按发行版（Centos/Ubuntu/Debian）给可复制 `curl -sSO .../install_panel.sh && bash install_panel.sh` 命令，版本选择（推荐 13.2.0 / 历史版）。
- **1Panel**（首页「免费安装」→ `https://docs.fit2cloud.com/1panel/installation/enterprise-installation`）：顶栏「在线体验 https://demo.1panel.cn/」「免费安装」「代码仓库」；文档中心概览有「快速入门：安装部署 / 应用安装 / 快速建站 / 证书配置」。
- **我方**：`kore/README.md:13-24`「按目的选入口」表指向 `QUICKSTART.md`（从零到登录约 5 分钟）、`docs/RUNBOOK.md`、`docs/OPERATIONS.md`、`docs/README.md`；`:144-158` 快速开始给 `make build && ./bin/kored` + `make docs-check`；`QUICKSTART.md:1-12` 有真实构建/登录步骤。但 `README.md:144-146` 仍写「M1 起可用…M0 占位」，与 0.1.5 现状漂移；在线站无「在线体验」入口。
- **判定**：**部分持平**（都有快速开始文档入口）；**我方缺**一键复制安装命令落到官网首页、在线 demo 入口，且 README 引导语过时属实锤（`:146` vs CHANGELOG `[0.1.5]`）。

#### ④ 文档入口完整度
- **BT**：首页导航「帮助文档 → https://docs.bt.cn/」；文档站 200，含「🚀快速开始 / 📖用户指南 / 🛠️实战教程 / ❓常见问题 / API 参考」，并提供 `index.md`、`llms.txt`（面向 AI/搜索引擎）。
- **1Panel**：首页「使用手册 → docs.fit2cloud.com/1panel/」；文档站侧栏 60+ 条目（概览/安装部署/功能手册/常用软件/API 接口/典型场景/运维指南/常见问题/联系我们），版本切换 `v2`。
- **我方**：README `:20-22` 给 `docs/README.md` 总览入口；`docs/README.md:7` 指 `docs/site/index.html`（离线，54 条分类索引）；Wiki 六页 200 但 Configuration 页 1132 B 无实际配置内容、Changelog 页仍写 M0；无在线文档 URL、无版本切换、无 API 文档入口页面（文档仓库内有 `PLUGIN-PROTOCOL.md` 等但未在门面呈现为独立 API 站）。
- **判定**：**我方缺**（在线文档站、版本维度、系统 FAQ/API 专页）；**竞品缺：无法判定**（两家都有的东西，不能说谁缺）。我方离线文档站是**不同形态**，不按在线站可用性评判。

#### ⑤ 信任信号（版本 / 许可证 / 社区 / 更新日志）
- **BT**：首页「全球超2000万台服务器安装、近300万注册用户、持续维护10年」；下载页列 13.2.0/12.0.0 等版本与「兼容列表｜更新日志｜官网教程文档」链接；页脚有 GitHub `aaPanel/BaoTa`、开源许可协议、高新企业编号与 ICP/公安备案。
- **1Panel**：首页「37K GitHub Stars / 300万累计安装次数」；`versions.html` 列社区版 GPL-3.0（¥0）/专业版 ¥1500/企业版功能对比；`blog.html`「127 文章 / 4 年份 / 2026 年 11 月 20 日」产品动态；链接「代码仓库 GitHub」「论坛」「问题反馈」「许可协议」。
- **我方**：`README.md:3-5` CI/License(MIT)/Go 徽章，`:48-58` 三端镜像链接，`:217-227` MIT 声明 + CONTRIBUTING/SECURITY + 「不收集任何遥测」，`:249-251` star 引导；`CHANGELOG.md:5` `[0.1.5] - 2026-11-28`；Wiki 六页可访问。但**门面无安装量/STAR 数等量化信任数据、无版本对比页、无独立产品动态页**；Wiki Changelog 页陈旧（仍 M0）。
- **判定**：**部分持平**（许可证/社区入口/ChangeLog 都有）；**我方缺**量化采用数据、版本对比页、产品动态聚合页；竞品未在我方维度缺失。**不能据文案判产品更可信**。

#### ⑥ 中文优先与手机适配
- **BT**：`<html lang="zh-CN">` + `<meta name="viewport" content="width=device-width,initial-scale=1">`（curl 原文）；文档站 `<html lang="zh-Hans">` + viewport；中文导航为主。
- **1Panel**：首页 `<html lang="zh-CN">` + viewport width=device-width，顶栏有 English 切换；中文为默认。
- **我方**：`kore/README.md:7` 七语言链接（简中居首）；`docs/site/index.html:3,6` `lang="zh-CN"` + viewport；`market/index.html:2,5` 同；`market/index.html:19-40` flex-wrap/auto-fill/深浅色、44px 搜索框。仓库主线中文、英文可选（`AGENTS.md` G-11 允许骨架例外）。
- **判定**：**持平**（三家默认中文 + 有 viewport 声明；我方静态页有响应式 CSS）。**注意**：这是**源码声明级**证据，非真机截图/多尺寸实测；按 G-28 真要判 UI 适配需双端截图，本卡不做。

### 对标总表（结论口径）

| 维度 | BT | 1Panel | 我方 | 判定 |
| --- | --- | --- | --- | --- |
| ① 首屏定位语 | 简单好用/安全高效 | 现代化开源+AI | 薄壳内核、资源零侵占 | 持平（取向不同） |
| ② 功能展示 | 六块编号+产品矩阵 | 四特性+244 应用商店 | 表格+24 条字段卡片，无截图 | 我方缺（截图/场景演示）；卡片形态基础持平 |
| ③ 快速开始 | 4 步 + 可复制安装命令 | 在线体验+安装文档 | README→QUICKSTART；引导语漂移 | 部分持平；我方缺在线体验/首页安装命令 |
| ④ 文档入口 | docs.bt.cn（快速开始/指南/FAQ/API） | 60+ 项文档+版本切换 | Wiki 六页 + 离线 54 条文档站 | 我方缺（在线站/API 专页/版本维度）；形态不同 |
| ⑤ 信任信号 | 2000万安装/10年/版本/备案 | 37K star/版本对比/127 动态 | MIT/CI/三端镜像/CHANGELOG | 部分持平；我方缺量化采用数据/版本对比/动态页 |
| ⑥ 中文+手机 | zh-CN + viewport | zh-CN + viewport + English | zh-CN + viewport + 7 语言链接 | 持平（仅声明级，非实测） |

## 诚实边界

1. 竞品官网内容 = **官方声明**（营销数字如「2000 万台」「37K Stars」未独立核实），不是真机行为；本卡不安装/不登录竞品，任何「竞品功能如何」的判断均不在范围。
2. 形态不同：我方是 README/Wiki + 离线 HTML，竞品是在线官网 + 文档中心；**不做同口径实测**（加载速度、交互、移动端真机、转化路径均不比）。
3. 无原文级证据不判超越：所有对比均附可复核 URL 或 file:line；无证据处标「无法比」。
4. `curl` 代替 `web_fetch`：round21/37 记录 web_fetch 被 SSRF 拦截，本轮沿用 curl 只读 GET/HEAD；1Panel 默认 UA 403 后换浏览器 UA 才可读，已如实标注，不代表站点对普通浏览器不可用。
5. Wiki raw 首轮 `Usage`/`FAQ` 瞬时 000，重试 200，已记录；HTML HEAD 六页均一次 200。
6. 本卡只读核实 + 单一报告文件提交；不改生产代码、不 bump、不发版、不 push。
