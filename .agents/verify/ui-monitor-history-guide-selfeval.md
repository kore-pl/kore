# 监控空态「先启用插件」引导 · 增量双端截图与自评（G-28 / task-211）

> 2026-11-27 19:14–19:20 +08:00 · 执行者 `monitor-guide-fix` · 持续目标 round 23 · 仅空态**增量**取证，不重拍既有时间范围图（原图见 [ui-monitor-history-selfeval.md](ui-monitor-history-selfeval.md)）。
> 隔离实例：`--config .agents/verify/.tmp-mguide/config.yaml`，端口 **127.0.0.1:55123**（非 8787），独立 config/state/run/log + 独立新编译 `bin/kored`（`CGO_ENABLED=0 GOWORK=off GOPROXY=off`，从当前 HEAD 含新提示的 `web/dist` 编入）；离线安装 `monitor-0.6.0.tar.gz` 后经 API 启用，插件未建任何采样任务、无 `history.json`，故呈现空态。**本轮未改动主实例运行态**（`.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/` / 8787 二进制零写入；8787 仅 `ss` 只读观察端口，未参与本轮取证）。口令只以运行期随机串写入隔离 config（0600），明文不进报告 / 截图 / 提交。
> 浏览器：隔离实例本地页面 + `/home/pt/.cache/pw-runner`（playwright 1.65.1 / chromium 1255，headless），无联网业务。收工已停实例、删除 `.tmp-mguide/`（含一次性脚本 / cookie jar / 口令文件 / 独立缓存）。

## 1. 增量截图与尺寸实测

| 文件 | `identify -format '%f %wx%h %b'` | 目视核对（read_image 实读） |
| --- | --- | --- |
| [ui-monitor-history-guide-desktop-01.png](screenshots/ui-monitor-history-guide-desktop-01.png) | `1440x2934 280813B`（宽 1440，full-page 高 ≥900） | 系统监控页 → 历史曲线面板（今天/昨天/7天/自定义 + 日期框）→ 空态标题「监控数据还在收集中」→ 原说明「还差采样点…」→ **新增一行白话提示「离线安装后，请先到「插件」页启用监控插件，再回来建采样任务；直接建任务会失败。」** → 按钮「一键开启连续采样」；无 canvas、无白屏，下方磁盘/网络/温度/进程 Top10 正常 |
| [ui-monitor-history-guide-mobile-01.png](screenshots/ui-monitor-history-guide-mobile-01.png) | `390x4094 255570B`（精确手机视口，非同图缩放） | 窄屏单列：时间范围按钮与日期框换行自适应；同一提示在「一键开启连续采样」按钮上方完整可读，无截断；底部 tab 不压提示与按钮（整页截图里 tab 悬浮在中部，属 fixed nav 截图表现，未遮挡本次新增文案） |

- 两图 sha256 不同：桌面 `788fd49a…665c` / 手机 `626772aa…feb690`，非同图缩放冒充双端。
- DOM 断言（两端一致）：`HINT_COUNT=1`、`HINT_VISIBLE=true`、`TITLE="监控数据还在收集中"`、`BUTTON="一键开启连续采样"`、`CANVASES=0`；浏览器 console 无异常。
- 截图场景是**有插件、无采样点**的真实空态；提示文案是通用操作说明（离线安装后先启用再建任务），不伪造 E_CONFLICT 报错、不改内核行为。

## 2. 门禁命令 + 退出码

```
kore$ node --check web/monitor.js                         EXIT=0
kore$ make frontend                                      EXIT=0（首屏 gzip 91092 B ≤ 307200 B；零 source map）
kore$ make docs-check                                    EXIT=0（5 pass / 1 WARN 行数 / 0 fail）
kore$ bash scripts/usability-check.sh --no-run-tests     EXIT=0（0 pass / 502 warn / 0 fail / 190 unverified；无新增 FAIL）
kore$ identify -format '%f %wx%h %b\n' <两张截图>        EXIT=0（见上表）
```

> `make frontend` 的首屏漂移 WARN 为存量（基线 87341 / 绝对线 90000），本次只改懒加载视图 `monitor.js`，首屏六件套未动；`usability-check` 的 502 WARN 含他人 dirty 的 `usability-pending.txt` 存量豁免，A4 未命中新增文案（术语自检：实例 / 生命周期 / capability / revision / E_CONFLICT 零命中）。

## 3. 产品定位自评（三问）

**问 1：本页解决什么用户问题？**
P3 真机复验暴露：离线 `kored install` 只把插件登记为「已安装未启用」，用户照监控页空态的「一键开启连续采样」跳到计划任务页建任务，到点会拿到「插件未启用」错误而白忙一场。现在空态在按钮旁直接给一行白话说明：离线安装后先到「插件」页启用监控插件，再回来建采样任务。用户不用理解错误码、不用猜失败原因，空态从「给下一步按钮」升级为「给可成功的下一步按钮」。不新增控件、不改交互路径、仍是一行提示 + 一个 CTA（UI 减法，易用性原则③④）。

**问 2：与宝塔 / 1Panel 同类功能的差距？**
宝塔/1Panel 的监控开箱即有服务端采集，装完就能看到曲线。kore 是薄壳 + 插件形态：监控由用户自建周期性采样任务驱动，默认不注册任务（G-19/G-10），离线安装的插件还需显式启用。本次提示把这条真实操作前置条件讲清楚，缩小「看起来能点、点了却失败」的体验差距；但仍有差距——没有服务端时序库、没有跨主机聚合、需要用户核对并点一次「新增任务」（不自动建任务）。这是既有设计边界，不在本卡扩大。

**问 3：当前是「可用」还是「占位」？**
**可用（受控范围）。** 判据：①隔离实例真机双端截图均可见新提示，DOM 断言 `HINT_VISIBLE=true`，按钮与空态标题都在，canvas 为 0（真无数据，非伪造）；②提示只复用 `KoreUI.emptyBlock` 既有的 `hint` 槽位，不新增实质控件、不引入内部术语（A4 零命中）；③后端逻辑、插件版本、索引、主实例均未改动，P3 五项断言结论不受影响；④门禁全绿（node --check / frontend / docs-check / usability 0 FAIL）。诚实边界：本轮只拍空态增量，时间范围图沿用 P2 证据；真实跨天采样由 P3 报告覆盖；降权路径仍留后续卡，不冒充已验。
