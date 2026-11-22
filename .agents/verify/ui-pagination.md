# UI 列表分页 + 防火墙 E_NEED_ROOT 真机验收（G-28）

> 元信息: 2026-11-23T06:58+08:00 · 执行者 fix-pagination-perms · 8787 主实例（PID 1266053→1338444）· 防火墙 403 在隔离实例 18861（独立 config/state/log/index，`store.allow_unsigned`）验证 · 报告 ≤80 行

## 1. 三个问题的修法

| # | 问题 | 修法 | 文件 |
| --- | --- | --- | --- |
| 1 | 列表全量渲染，页面 11 屏 | Redis 默认 50 行 + 「加载更多」+「已显示 X / 共 Y 个键」，pattern 查询重置到 50；进程默认 20 行 + 每次 +20 +「已显示 X / 共 Y 个进程」，排序/过滤重置；商店每页 12 + 上/下一页 + 第 P/T 页，分类/搜索重置 | `web/redis.js` `web/process.js` `web/store.js` |
| 2 | root 缺失被报成 HTTP 401 | 插件把权限类失败映射为 `E_NEED_ROOT`（本地常量，pluginapi v0.1.1 尚未含该常量）+ `detail.hint`；内核 `statusFor` 对 `E_NEED_ROOT` 返回 403；SSH 安全护栏仍保留 `E_UNAUTHORIZED` | `kore-plugin-firewall/internal/fwop/{call,types,runtime,errors}.go` |
| 2 | 前端把英文错误铺在页面 | `E_NEED_ROOT` → 折叠的「防火墙管理需要 root 权限 / 查看如何配置」指引（命令 + 后端 hint，原始错误再嵌一层折叠）；仅 `E_UNAUTHORIZED` 提示重新登录 | `web/firewall.js` |
| 3 | `runtime-php` 停用态读成异常 | 行状态/备注/顶部汇总统一改「已停用」，行内保留「启用」按钮；文案明确是用户主动停用 | `web/app.js` |

## 2. 页面高度前后对比（`document.body.scrollHeight`，1440 宽）

| 页面 | 改前 | 改后 | 实测行数/文案 |
| --- | ---: | ---: | --- |
| Redis | **9,405 px** | **3,062 px** | 50 行 · `已显示 50 / 共 6,662 个键` + 加载更多 |
| Redis（点一次加载更多） | — | 5,187 px | 100 行 · `已显示 100 / 共 6,662 个键` |
| 进程 | **3,973 px** | **1,085 px** | 20 行 · `已显示 20 / 共 800 个进程` + 加载更多；再点 → 40 行 |
| 商店 | **1,876 px** | **1,210 px** | 12 卡 · `第 1 / 2 页 · 共 24 个插件`，下一页仍 12 卡 |
| 防火墙（隔离实例） | — | 931 px | 折叠指引默认收起（`details[open]=false`） |

## 3. curl 原始响应（隔离实例 18861，已安装 firewall 0.2.3）

```
HTTP/1.1 403 Forbidden
Content-Type: application/json; charset=utf-8
X-Request-Id: r-bd9f2772598d1b3b
Content-Length: 505

{"code":"E_NEED_ROOT","message":"执行 `/usr/sbin/ufw status numbered` 失败: ERROR: You need to be root to run this script（插件需要 root 权限才能读取/修改防火墙）","detail":"{\"hint\":\"需 root 权限：请用 sudo/systemd 启动 kored，或让内核经 POST /api/v1/plugins/firewall/root-action 执行 ufw-status / iptables-s\"}","hint":"需 root 权限：请用 sudo/systemd 启动 kored，或让内核经 POST /api/v1/plugins/firewall/root-action 执行 ufw-status / iptables-s"}
```

- `firewall.status` 同环境返回 HTTP 200 + `available=false` + `error_code=E_NEED_ROOT` + `hint`（与 ADR-0018 一致）。
- 8787 主实例索引尚未收录 0.2.3（见 §6），因此主实例仍跑 0.2.2；403 语义用同一 kored 二进制 + 0.2.3 包在隔离实例验证。

## 4. 截图（`.agents/verify/screenshots/`，identify 实测）

| 文件 | 尺寸 | 断言 |
| --- | --- | --- |
| `pg-redis-desktop.png` | 1440x3062 | 50 行 + 共 6,662 + 加载更多 |
| `pg-redis-loaded-desktop.png` | 1440x5187 | 点击后 100 行 |
| `pg-redis-mobile.png` | 390x844 | 手机端 50 行 + 加载更多 |
| `pg-process-desktop.png` | 1440x1085 | 20 行 + 共 800 + 加载更多 |
| `pg-process-mobile.png` | 390x844 | 手机端进程列表 |
| `pg-store-pagination-desktop.png` | 1440x1210 | 第 1/2 页 + 上一页/下一页 |
| `pg-store-pagination-page2-desktop.png` | 1440x1210 | 第 2/2 页 12 卡 |
| `pg-store-pagination-mobile.png` | 390x844 | 手机端分页控件 |
| `plugins-stopped-desktop.png` | 1440x1563 | `已停用 1` + runtime-php 行「已停用」+「启用」 |
| `plugins-stopped-mobile.png` | 390x844 | 手机端已停用文案 |
| `perm-firewall-guide-desktop.png` | 1440x931 | 折叠指引（默认收起） |
| `perm-firewall-guide-expanded-desktop.png` | 1440x1079 | 展开后的配置步骤/命令 |
| `perm-firewall-guide-mobile.png` | 390x844 | 手机端折叠指引 |

## 5. 门禁（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | ---: | --- |
| `node --check web/{redis,process,store,firewall,app}.js` | 0 | `NODE_CHECK_OK` |
| 插件仓 `make check` | 0 | gofmt clean / vet / 4 包 test 全 ok |
| 插件仓 `make dist` ×2 | 0 | 两次 sha 均 `353d5626453276b2adeae4db935c2eb6837e84e2e59f052d96828d568b8c651b`（位级一致） |
| `make frontend` | 0 | 首屏 43,397 B gzip ≤ 300 KiB |
| `make docs-check` | 0 | 5 pass / 1 既有 WARN / 0 fail |
| `make check` | 0 | 11/11 门禁全部通过 |

## 6. 插件版本、发版与遗留

- firewall **0.2.3**（info.json / manifest.json / CHANGELOG 同步），dist sha256 `353d5626…c651b`，已 push `main` + tag `v0.2.3` + GitHub release（asset `firewall-0.2.3.tar.gz`）。
- **遗留（需人处理）**：kore-plugins 索引重签缺 key #22 私钥（本机仅存 `~/.kore/index-key-18.pem`，对应公钥 `b4c4…`，与 kore 内嵌 `8338…` 不匹配），因此防火墙 0.2.3 尚未入索引/预设、8787 商店仍显示 0.2.2。持私钥环境需：改 `index/plugins.json` + `versions.lock.json` + 3 个 preset 的 firewall 版本 → `scripts/sign-index.sh` → `validate-index.sh`/`validate-presets.sh`。
- 8787 两次重启均只为加载新前端产物（`bin/kored` 重建）；主实例 `.kore-local.yaml` 未改，`paths.index_dir` 仍为 `kore-plugins/index`，重启后商店 24 条、HTTP 200。隔离实例验收后已停止并删除临时目录。
