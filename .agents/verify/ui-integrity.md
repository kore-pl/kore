> 元信息: 2026-11-23T10:11+08:00 · 执行者 r6-integrity-ui（子 agent）· integrity 0.2.0 完整性校验页 · 真机 8787 + Playwright 真 chromium · 报告 ≤70 行

# integrity 完整性校验页（`web/integrity.js`）

## 0 交付面

- 新增 `web/integrity.js`：237 行（≤280 上限），零框架 / 零 CDN / 无外链；样式随视图注入，不占首屏 style.css 预算。
- 接线：`web/shell.js`（ICONS 双层盾+勾、平台组插在「已装插件」后、hasIntegrity + lazyView）、`Makefile`（28 文件 / 16 视图模块）、`web/embed.go`（`dist/integrity.js`）、`docs/FRONTEND.md`（视图清单 / 首屏口径 / 18 项导航 / 第 9–18 个内置项）。
- 契约：`POST /api/v1/invoke/integrity/integrity.<status|baseline|check|verify_file>`，错误透出内核 `hint`。

## 1 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node --check web/integrity.js` | 0 | 无输出（语法通过） |
| `make frontend` | 0 | 28 文件打包；首屏四件套 gzip 46240 B / 307200 B |
| `make docs-check` | 0 | 5 pass / 1 warn（PLUGIN-PROTOCOL 437 行、RELEASE 40 行越界，均为既有） |
| `make check` | 0 | 11 段全绿：case 28 pass、secret 0 FAIL、首屏达标 |

## 2 真机验证（8787，PID 2547031，20 个已装插件，integrity 0.2.0）

| # | 动作 | 实测结果 |
| --- | --- | --- |
| 1 | 打开 `#/integrity`（无基线） | 大字「尚未建立完整性基线」+ 说明 + 「建立基线」；导航 18 项、`完整性` 位于「平台」组第 3 位 |
| 2 | 弹层点预设「站点文件」 | `is-on=1`，排除规则预填 `*.log, *.tmp, */cache/*` |
| 3 | 提交 `/var/www` | `entries=0 / 93 B→0 B / 9 ms` + `warnings:["路径不存在，跳过: /var/www"]`；页面显示黄底「基线已保存，但一条文件都没记录」（**不假装成功**） |
| 4 | 重建基线 → 自定义 `…/plugins/integrity/probe` | `记录 3 个文件 · 93 B · 3 ms`；状态卡 建立时间 / 条目 3 / 93 B / 从未校验 |
| 5 | 立即校验（未改动） | 绿「未检测到改动」· 未变化 3 个 |
| 6 | 改 `probe/site/index.html` 后校验 | 红「检测到 1 处改动」· 未变化 2 个；三表 `新增(0)/删除(0)/修改(1)`；行内 `03cfceea → 803ac2a0` + `sha256`，详情展开含完整路径与 `0644 → 0644` |
| 7 | 单文件校验（改动后真实 sha） | `match: true · 文件未被改动`，实际/期望 sha 均为 `803ac2a0…5ae4d2` |

- 网络与 console：849 次请求中仅登录前 2 次 `system/info 401`（预期）与 favicon 404；integrity 页零 console error、零外链、零请求失败。
- 双端无横向溢出：手机 `document.scrollWidth = 390`（空态 / 校验 / 单文件三态均实测）。

### 2.1 与验收口径的偏差（必须写明）

本机 `/var/www` 不存在，且 kored 以普通用户运行（`NoNewPrivs: 1`，sudo 不可用），无法创建该目录。
处理：① 预设 `/var/www` 仍按验收要求真点、真提交、真截图，暴露的是插件真实 warning 与页面真实降级文案；② 建立→改文件→检测到 的完整链路改用插件白名单内可写目录 `…/.kore-local-state/plugins/integrity/probe`（3 文件 / 93 B，含 `site/index.html`），三态覆盖与 `/var/www` 等价；未改白名单、未加 `KORE_INTEGRITY_ALLOW_ROOTS`。

## 3 截图（G-28，`.agents/verify/screenshots/`，`file` 实测宽高）

| 桌面（1440 宽，full-page） | 手机（390 宽） |
| --- | --- |
| `int-empty-desktop.png` 1440×900 | `int-empty-mobile.png` 390×844 |
| `int-baseline-desktop.png` 1440×900 | `int-baseline-mobile.png` 390×844 |
| `int-check-modified-desktop.png` 1440×1043 | `int-check-modified-mobile.png` 390×1308 |
| `int-check-modified-detail-desktop.png` 1440×1205 | — |
| `int-verify-desktop.png` 1440×1309 | `int-verify-mobile.png` 390×1448 |
| 旁证：`int-nav-desktop.png`（平台组位置）、`int-dialog-desktop.png`（预设多选）、`int-check-clean-desktop.png`（绿结论）、`int-baseline-varwww-empty-desktop.png`（空基线告警） | — |

## 4 产品定位自评（G-28 三问）

1. **解决什么用户问题**：装完 kore 后「我怎么知道 `/etc/nginx` 的配置有没有被人改过」——一次点预设建基线，之后一键比对新增/删除/修改，改动的文件直接给新旧 sha256 前 8 位，可疑文件可单独核对指纹。解决的是「事后可举证」，不是「事前阻断」。
2. **与宝塔 / 1Panel 的差距**：宝塔的「文件校验」偏向整机体检 + 木马特征库，1Panel 靠容器镜像不可变来兜底；本页**没有**特征库、没有实时告警推送（插件 `未完成项` 明确事件投递延后）、没有定时校验（需手动点或后续调度器接），也**不做** root 提权与自动修复。优势是零依赖、指纹可自证、白名单边界（默认只认 5 个根）可审计。
3. **当前状态：可用**（不是占位）。四条方法全部打通并有真机证据；未做的是「告警/定时」，已在页面上不承诺。

## 5 运行态与风险声明（G-29 / 并发）

- 本轮改过运行态：`make build` 重建 `bin/kored` 并以**同 config、同 env、同用户**重启（PID 2461308 → 2547031，`healthz 200`）；未改 `.kore-local.yaml`、未动 `index_dir`、未改插件白名单。
- 插件侧留下演示态：`…/plugins/integrity/baseline.json`（3 文件基线）与 `probe/` 测试树；清零只需删除这两个路径（均为 gitignore 的运行态）。
- 与 `r6-runtime-ui` 并发共享 4 个文件：其 runtimes 接线已由其 commit `40362f3` 落库，我这笔只带自己的 delta（含双方共用的计数最终态 28 文件 / 16 模块 / 18 项导航）。
