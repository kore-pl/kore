# 备份校验 · G-28 双端截图验收（主壳 web/backups.js）

> 任务：补 `7787aa7`（备份校验搬到主壳）的 G-28 双端证据。
> 角色：verifier（shot-backup-verify）。写域：本文件 + `screenshots/backup-verify-*`。**未改任何代码。**

## 1. 环境与实例（G-29）

| 项 | 值 |
| --- | --- |
| 实例 | 隔离实例 `/tmp/kore-bkv`，`server.addr=127.0.0.1:18871` |
| 配置 | `/tmp/kore-bkv/config.yaml`（`auth` 由 `kored admin-password --generate` 生成，口令仅存 `/tmp`，本文件不记录明文） |
| 状态 / 运行 / 日志 | `/tmp/kore-bkv/{state,run,log}`（全部落 `/tmp`） |
| 索引 | `paths.index_dir=/home/pt/Work/GolandProjects/kore-plugins/index`（只读指向，未改索引） |
| 启动 | `KORE_BACKUP_DIR=/tmp/kore-bkv/backups KORE_BACKUP_ALLOW_ROOTS=/tmp ./bin/kored serve --config /tmp/kore-bkv/config.yaml` |
| 就绪 | `curl -s -o /dev/null -w '%{http_code}' :18871/-/healthz` → `200`；日志 `kore ready ... version 0.1.0` |
| 端口 | 启动前 `ss -ltn` 无 18871；收工后 18871 已释放（见 §7） |

**主实例**：8787 全程零写入、未重启、未改 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`。本轮**未改动主实例运行态配置**。

## 2. 安装与造数据

| 步骤 | 命令要点 | 结果 |
| --- | --- | --- |
| 登录 | `POST /api/v1/auth/login` | `200`，两次 `Set-Cookie`：`kore_session`（HttpOnly）+ `kore_csrf`；后续写操作带 `X-Kore-CSRF` |
| 商店装插件 | `POST /api/v1/store/install {"download":true,"id":"backup","version":"0.4.2"}` | `200`（`state=succeeded`，`reload=reloaded`）；`GET /plugins` 版本 **0.4.2**、`latest_version 0.4.2` |
| 启用 | `POST /api/v1/plugins/backup/enable` | `200`，`enabled=true` |
| 造正常备份 | `POST /api/v1/invoke/backup/backup.create {"name":"g28-ok","paths":["/tmp/kore-bkv/data/docs"]}` | `200`：`id=g28-ok-20261123T134345Z`，40577 B，3 条目，`sha256=e2c80987…` |
| 造坏备份 | 同名再建 `g28-bad`，随后 `truncate -s $((size/2))` 截断到 20288 B | `id=g28-bad-20261123T134408Z` |

**造数据结论：成功**（未走降级兜底路径；降级态另行模拟，见 §4）。

## 3. 四种状态 × 双端截图（`file` 实测宽高）

PC 视口 1440×900 full-page；手机视口 390×844（`isMobile`、DPR=1）full-page。宽高为 `file` 实读，高度即整页高度（> 视口为 full-page 所致）。

| 场景 | 文件 | `file` 实测 |
| --- | --- | --- |
| ① 备份列表 + 「校验」按钮 | `screenshots/backup-verify-list-desktop.png` | PNG 1440 x 1935 |
| ① 备份列表 + 「校验」按钮 | `screenshots/backup-verify-list-mobile.png` | PNG 390 x 2349 |
| ② 校验通过态（绿 chip + sha256/大小/时间） | `screenshots/backup-verify-ok-desktop.png` | PNG 1440 x 2025 |
| ② 校验通过态 | `screenshots/backup-verify-ok-mobile.png` | PNG 390 x 2436 |
| ③ 校验失败态（红 chip + 首项失败 detail 原文） | `screenshots/backup-verify-fail-desktop.png` | PNG 1440 x 2058 |
| ③ 校验失败态 | `screenshots/backup-verify-fail-mobile.png` | PNG 390 x 2466 |
| ④ 降级态（按钮 disabled + title） | `screenshots/backup-verify-legacy-desktop.png` | PNG 1440 x 1935 |
| ④ 降级态 | `screenshots/backup-verify-legacy-mobile.png` | PNG 390 x 2349 |

四态 **8/8 全部截到**，无「没截到」项。未拿同图缩放冒充双端（宽 1440 与 390 为两次独立渲染）。

## 4. 页面实测文案（原文摘录）

**② 通过态**（`backup.verify` 返回 `ok=true`，`legacy=false`）
- chip：`校验通过`
- 元信息行（`.bak-verify-meta`）：`sha256 e2c80987717c · 39.6 KiB · 2026/11/23 21:43:45`

**③ 失败态**（截断后 `ok=false`）
- chip：`校验失败`
- detail 原文（`.bak-verify-detail`，取 `checks[]` 中**第一个** `ok=false` 项，即 `sha256` 项）：
  `sha256 与记录不一致：内容被改动或写入不完整（记录 e2c80987717c…，实际 afb8da3e900c…）`
- 次行 meta：`sha256 afb8da3e900c · 19.8 KiB · 2026/11/23 21:44:08`

> 观测：后端 `checks[]` 顺序为 `exists → size → sha256 → size_recorded → readable → entries`。截断后 `sha256` 先于 `size_recorded` 失败，因此主壳按「仅第一项失败 detail」规则展示的是 sha256 文案，而不是任务书举例的「文件不完整（实际 X 字节 < 记录 Y 字节，疑似被截断）」。后端该条文案确实存在（本次响应的第 4 项），只是不是首项。**这是契约符合预期的呈现，不是缺陷**；若希望截断场景优先展示「文件不完整」，需调整后端 checks 顺序——属产品判断，不在本次写域内。

**④ 降级态**
- 按钮 `disabled=true`，`title="当前备份插件版本不支持校验，请升级插件"`。
- 说明：本机索引只有 `backup@0.4.2`，无法真装 `<0.4.2` 旧版；降级态通过 Playwright 在 `GET /api/v1/plugins` 响应层把 `version` 改写为 `0.4.1` 触发（`versionAtLeast` 分支），**其余数据全部真实**。这是对「旧版插件按钮 disabled + title」这条 UI 分支的真实渲染，但版本号是桩，已在未验证项中声明。

## 5. 截图工具链（原文）

- Playwright **playwright-core 1.65.0**（`npm i playwright-core@1.65.0`，装在 `/tmp/bkv-tools`，收工删除）
- 浏览器：**显式 `executablePath`** = `/home/pt/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（`Google Chrome for Testing 156.0.8078.4`）
- 无报错；页面控制台仅 6×404（静态子资源，如 favicon/字体）与 1×401（未登录首屏探测），不影响截图内容。

## 6. 自评三问（G-28 第 ③ 项）

**① 本页解决什么用户问题？**
「备份到底能不能用」这个不可回避的信任问题。用户不再需要下载 tar.gz 手工 `sha256sum` 对比，也不用去翻插件日志：列表行内点一次「校验」，直接得到三态判定 + 具体失败原因（哪一个检查项、记录值 vs 实际值），把「备份存在」升级为「备份可恢复」。失败 detail 原文（而不是笼统「校验失败」）决定了用户下一步是重跑备份还是排查磁盘/写入，这是本页的核心价值。

**② 与宝塔、1Panel 同类功能的差距？**
- 领先：**逐份备份的行内校验** + **结构化 checks[] 逐项文案**（exists/size/sha256/size_recorded/readable/entries）。宝塔/1Panel 的备份页主要展示文件列表与大小，校验多为「恢复时才知道坏了」或仅提示文件存在；把「记录值 vs 实际值」摆到行内，是它们的常规形态没有的颗粒度。
- 落后：**缺少备份内容预览与选择性恢复**（宝塔支持按文件浏览归档内容、部分恢复）；**没有远端异地存储**（两家都有一键上云）；**没有进度可视化到秒级**（本页只到「最近作业」阶段）；**保留策略只有份数**，没有按容量/按天数的组合策略。
- 中性：本页仍以「列表 + 行内展开」为主，信息密度低于宝塔的备份详情抽屉。

**③ 当前是「可用」还是「占位」？**
**可用**。真机实测（隔离实例 + 真实 0.4.2 插件 + 真实 tar.gz）：正常备份点「校验」得到绿 chip 与 sha256/大小/时间；截断一半后得到红 chip 与首项失败 detail 原文；旧版本分支按钮正确 disabled 并给可操作 title。无接口 200 代替截图、无 DOM 断言代替视觉证据。局限见 §7。

## 7. 清理与未验证项

**清理**（收工执行，证据见提交时的命令输出）：
- 停止 18871 上的 `kored serve`，`rm -rf /tmp/kore-bkv /tmp/bkv-tools`
- `ss -ltn | grep 18871` → 无输出（已释放）
- 主实例 8787：`curl -s -o /dev/null -w '%{http_code}' :8787/-/healthz` → `200`，全程未重启、未写入
- 其他 `kored serve` 残留：仅报告，不杀（见交付回报）

**未验证项**：
1. **降级态版本号为网络层桩**：真实 `<0.4.2` 旧插件包未安装验证（索引无旧版）。UI 分支真实渲染，但「旧插件真实返回 404/无 checks[] 契约时的完整降级链路」未跑。
2. **`legacy=true` 黄 chip 未截到**：需要「旧备份未记录 sha256」的数据（生成它要伪造 sidecar/旧格式备份文件），本轮时间盒内未造；代码分支存在（`backups.js` 中 `add(box, chip('warn', '旧备份未记录 sha256，仅检查了可读性'))`），**未取得截图证据**。
3. **手机端交互未做触摸手势验证**：仅按 390×844 视口渲染并截 full-page，未验证 44px 触摸目标与折叠面板的展开行为。
4. **失败态展示的是 sha256 文案而非截断文案**（见 §4 说明），未改任何代码去调顺序。
