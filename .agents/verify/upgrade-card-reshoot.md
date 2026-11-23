# 升级内核卡片 · G-28 双端重拍（装配修复后）

> 元信息: 2026-11-24T00:19+08:00 · 执行者 `upgrade-card-reshoot` 子 agent · 隔离实例 `127.0.0.1:18987`（config/state/run/log 全在 `/tmp/upgrade-reshoot`）· 构建自带 `db7cf31` / `a68c4b1` 的提交 · 主实例 8787 **零写入**
>
> 结论：**①②③ 全部达成，① 为首次达成**。上次（`db36288`）`GET /api/v1/system/upgrade` = **501**「当前装配不支持内核自升级」；本次同端点 = **200**，卡片直接渲染当前版本/sha、可回滚目标与 `can_upgrade=false` 的可操作原因。③ 拿到真实服务端 `E_NEED_ROOT`（403）。未改任何代码。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 监听 | `127.0.0.1:18987`（`ss -ltn` 先确认空闲；未碰 8787） |
| 配置 | `/tmp/upgrade-reshoot/config.yaml`（独立 `--config`） |
| 状态 / 运行 / 日志 | `/tmp/upgrade-reshoot/{state,run,log}`（全落 `/tmp`） |
| 索引 | **只读**指向 `/home/pt/Work/GolandProjects/kore-plugins/index` |
| 二进制来源 | `git archive 179daaa` → 在 `/tmp` 副本内 `make build`（`web/dist/` 被 `.gitignore`、archive 本体不含嵌入资产，故按 Makefile 的 `web-dist` 规则在副本内重建 dist 后编译；未读共享工作树代码） |
| 二进制 sha256 | `3e656b33750546cb88b17608f7a7bbacac5651726fec3757055128fe757ac783`（`kored 0.1.0`） |
| 修复链校验 | `git merge-base --is-ancestor db7cf31 179daaa` = yes；`a68c4b1` = yes |
| 进程身份 | **uid 1000 非 root**（沙箱限制，见 §8） |
| 截图工具链 | `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`（**显式 executablePath**，Chrome for Testing 156.0.8078.4）+ 裸 CDP（Node 24 内置 WebSocket） |
| 主实例声明 | 8787 仅做只读 `GET /-/healthz`（`{"status":"ok"}`），**未改** `.kore-local.yaml` / state / `bin/kored`，未重启 |

## 2. 复现要点

```bash
git archive 179daaa | tar -x -C /tmp/upgrade-reshoot/src
cd /tmp/upgrade-reshoot/src && make build BIN=/tmp/upgrade-reshoot/bin/kored
cp bin/kored bin/kored.prev                    # 造「可回滚目标」供 ① 展示
/tmp/upgrade-reshoot/bin/kored serve --config /tmp/upgrade-reshoot/config.yaml &
# 登录（独立口令，仅 /tmp 0600，未入库）：POST /api/v1/auth/login → cookie + kore_csrf
chrome --headless=new --remote-debugging-port=9411 --user-data-dir=/tmp/upgrade-reshoot/prof
node /tmp/upgrade-reshoot/cdp-shot.mjs 9411 18987 …  # 登录→?r=…#/settings→三场景双端
```

## 3. 真实 API 返回（UI 数据来源）

`GET /api/v1/system/upgrade`（带会话 cookie）→ **HTTP 200**：

```json
{
  "current": {
    "path": "/tmp/upgrade-reshoot/bin/kored",
    "sha256": "3e656b33750546cb88b17608f7a7bbacac5651726fec3757055128fe757ac783"
  },
  "previous": {
    "path": "/tmp/upgrade-reshoot/bin/kored.prev",
    "sha256": "3e656b33750546cb88b17608f7a7bbacac5651726fec3757055128fe757ac783"
  },
  "can_upgrade": false,
  "can_rollback": false,
  "reason": "当前进程不是 root：替换自身二进制与重启 systemd unit 都需要系统服务身份（ADR-0042）"
}
```

`POST /api/v1/system/upgrade`（`confirm=true` + 合法 bin/sha + `X-Kore-CSRF`）→ **HTTP 403**：

```json
{"code":"E_NEED_ROOT","message":"当前进程不是 root，无法自升级","detail":"需要 root 运行身份：当前 euid=1000；请以系统服务（root）运行内核后再从面板升级"}
```

## 4. 截图清单（`file` 实测宽高）

| 文件 | 实测 | 内容 |
| --- | --- | --- |
| `screenshots/upgrade-card-initial-desktop.png` | **1440 × 1759** | ① 初始态：`当前内核版本 0.1.0 · sha256 3e656b337505…757ac783` + 可回滚目标 + 非 root 原因（PC full-page） |
| `screenshots/upgrade-card-initial-mobile.png` | **390 × 844** | 同场景手机视口（卡片滚入视口） |
| `screenshots/upgrade-card-confirm-desktop.png` | **1440 × 1759** | ② 确认态：路径 + 64 位 sha + 已勾选「我了解升级会重启内核」 |
| `screenshots/upgrade-card-confirm-mobile.png` | **390 × 844** | 同场景手机视口 |
| `screenshots/upgrade-card-error-desktop.png` | **1440 × 1759** | ③ 结果态：真实 403 → `E_NEED_ROOT：当前进程不是 root，无法自升级`（红框） |
| `screenshots/upgrade-card-error-mobile.png` | **390 × 844** | 同场景手机视口 |

6 张均为本次（00:19）新拍，非旧图缩放或复用；桌面 full-page（`Page.getLayoutMetrics.cssContentSize`），手机固定 390×844 视口。

## 5. 三场景结论

| # | 要求 | 结论 | 证据 |
| --- | --- | --- | --- |
| ① | 当前版本/sha、可回滚目标、`can_upgrade` 原因 | **达成（首次）** | 卡片三点齐全（§4 首行 + §3 JSON）；上次同位置是「升级状态读取失败」+ 501 |
| ② | 填路径 + 期望 sha + 勾选确认 | **达成** | DOM 落值 `checked=true`、path=`/tmp/upgrade-reshoot/bin/kored`、sha=64 位；两按钮按 `can_upgrade=false` 保持禁用（产品行为） |
| ③ | 至少一种真实服务端反馈 | **达成** | 真实 POST → 403 `E_NEED_ROOT`，卡片渲染 `E_NEED_ROOT：当前进程不是 root，无法自升级` |

③ 方法说明：非 root 下「校验并升级」按钮按状态禁用，这是产品降级行为；为让真实服务端反馈落到卡片，用 CDP **仅把按钮 `disabled` 置 false 后点击**（不改代码、不 mock 响应），请求与渲染都走真实链路。

## 6. 产品定位自评三问（G-28 ③）

**① 本页解决什么用户问题？**
把「升级内核二进制」从 SSH + `kored upgrade --bin … --sha256 …` 搬进面板：运维不用进城、不用记命令；核心是**可控**——只认本机绝对路径（不下载 URL）、sha256 先校验后替换（不符零改动）、失败可 `.prev` 回滚、动作 fail-closed 进审计。装配修复后，连最基础的「我现在跑的是哪个版本 / 能不能升级 / 能不能回滚」也能在页面读到了。

**② 与宝塔、1Panel 的同类功能差距？**
宝塔/1Panel 走「面板内一键更新官方源」：省事但把信任交给官方源，不给期望 sha、通常不提供一键回滚到任意上一版。Kore 是「受控运维动作」路线，适合离线/内网/自签场景。差距仍在：① 无内置下载与签名源，二进制要用户先传上去；② 只有 `.prev` 一档，没有升级前快照/自动回滚；③ 进度只有 job 文案，没有阶段进度条；④ 非 root 环境整体不可用（这是设计，不是缺陷，但会劝退单机试用者）。

**③ 当前「可用」还是「占位」？**
**条件可用（root 下可执行；非 root 为显式降级，不再是占位）**。读路径（版本/sha/回滚目标/原因）与写路径（表单 → 二次确认 → job → 错误码渲染）都已接通并有真实服务端行为；但真实替换、重启、回滚在本机（uid 1000）跑不了，故只能声明「接线可用」，不能声明「升级链路已在真机验证」。

## 7. 边界与未达成项

- 三场景**全部达成**，无未达成项；未用旧图凑（见 §4 时间戳与尺寸）。
- **未覆盖**：真实替换 → 重启 → `pending→success` → `.prev` 回滚（需 root + systemd）；`E_UPGRADE_CHECKSUM`/`E_UPGRADE_SOURCE` 等其它错误码未在 UI 复测。这些不属本次三场景，但不得据此宣称「升级链路可用」。
- 快照里的「可回滚目标」是预放的 `<bin>.prev`（同 sha 副本），用于验证字段显示；`can_rollback=false` 因非 root，符合实现（root && previous != nil）。

## 8. 清理与门禁

- 隔离实例 `kored`（pid 2166268）与 Chromium 已 kill；`ss -ltn` 复核 18987/9411 已释放；`/tmp/upgrade-reshoot` 整目录删除（配置、口令、state、profile、截图源均不残留）。
- 主实例 8787 `/-/healthz` → `200`；本轮未写主实例运行态配置。
- 未改任何代码 / 测试 / 门禁脚本；改动仅 6 张截图 + 本文件。
