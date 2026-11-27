# UI 上传还原 · 三问自评（G-28 / task-242 P2）

> 实现：`kore/web/backups.js`（仅新增页头 1 个「上传备份」按钮 + 复用 `bak-confirm` 面板 / `ensureProgress` 进度 / `paintResult` 结果）。
> 证据：本目录 `screenshots/ui-upload-restore-*.png`，隔离静态页面（独立 config/state/run，非 8787、未碰主实例运行态）。
> 口径：本卡只做 UI 与前端接线验证；真机端到端上传→恢复（合法 / 恶意 / 超大 / 未授权）留 P3，不在此声称真机通过。

## 一、本页解决什么用户问题

BT「备份还原」有「上传本地备份还原」，此前备份页只能恢复**已在本地备份目录**的包：用户从别的机器/旧环境拿到 `.tar` / `.tar.gz` 后没有入口导入，只能手工拷进备份目录且无法校验完整性。现在页头「上传备份」按钮给出明确入口：选文件 → 确认导入，分块 4 MiB 传完即出现在本页列表，带「外部包」标记与 `.sha256` 校验结果；恢复仍走原有「恢复」按钮 + 页面内二次确认 + 插件白名单/空目录门，不新增破坏性路径。主流程 3 次点击（上传备份 → 选文件 → 确认导入），进度条显示真实已传字节而非伪百分比；旧插件（<0.6.0 或没有 `backup.upload`）自动隐藏按钮并提示升级。

## 二、与宝塔 / 1Panel 同类功能的差距

- **已补齐**：本地备份包上传导入、导入后即校验（`backup.verify` 的 `sha_match`）、复用既有恢复流程；不要求用户填目标目录以外的参数。
- **明确不做（非 G-11 的本次范围外）**：不做从 1Panel / AMH 等他面板备份格式的解析与语义映射（属跨面板迁移，触 G-11 有意偏离，需先写 ADR 并经用户裁决）；不做 S3 / 异地对象存储客户端（README:6 / backlog C3）。外部搬运仍由用户自己的同步工具负责。
- **诚实边界**：只能为「接收字节的完整性」背书（自算 `.sha256`），不能为第三方产物内部一致性背书；因此导入包不写 `.meta.json`、`Managed=false`，保留策略不会误删。上传本身不自动恢复，用户仍需显式点「恢复」并二次确认。
- **未验证项**：本轮未做真机端到端（合法包→恢复成功、恶意/超大/未授权被拒），不借本卡声称真机通过；见 P3 任务卡。

## 三、当前是「可用」还是「占位」

**可用（前端入口与交互已可用，后端方法已自测通过）**，不是占位：
- 按钮、文件选择、确认面板、真实分块进度、结果面板均为实际 DOM 与真实 `backup.upload` 调用（四阶段 begin/chunk/commit/abort），不是静态 mock 文案；截图来自运行中的 `KoreBackup.render()`。
- 后端 `backup.upload` 已过 `go test -count=1 ./...`、`make check`（含 race）、`go test -tags e2e`（真插件 UDS 上传→复用 restore）；安全门 S1–S9 单测覆盖合法/11 类恶意归档/超大/TTL/越权。
- 但**真机端到端未在本卡验证**，所以口径是「功能实现可用、真机复验待 P3」，不是「全链路已验收」。

## 截图与尺寸证据

| 场景 | 文件 | identify 实测 |
| --- | --- | --- |
| PC 页头按钮 | `screenshots/ui-upload-restore-desktop-01-page.png` | 1440×900 |
| PC 导入确认面板 | `screenshots/ui-upload-restore-desktop-02-confirm.png` | 1440×900 |
| 手机页头按钮 | `screenshots/ui-upload-restore-mobile-01-page.png` | 390×844 |
| 手机导入确认面板 | `screenshots/ui-upload-restore-mobile-02-confirm.png` | 390×844 |

命令与退出码：`node --check web/backups.js` → 0；`make frontend` → 0（首屏 91092 B ≤ 300 KiB）；`identify screenshots/ui-upload-restore-*.png` → 0（四张宽高如表）；`bash scripts/usability-check.sh` → 本功能无新增 FAIL（新增文案均为存量豁免 WARN；输出中的 waf A1 与本功能无关）。
