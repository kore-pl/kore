# 热升级静默失效 + 商店验签提示 + force 重装（真机验收）

> 元信息: 2026-11-23T02:20+08:00 · 执行者 fix-hot-upgrade 子 agent · 隔离实例 18877/18878 · 8787 未触碰

## 1. P0 根因与修法（reloadOne）

**改前**（`cmd/kored/serve_runtime.go:111`）：已登记 id 直接 `return nil`，只覆盖“首次增量登记”；同 id 装新版本时 catalog/supervisor 仍停在旧版本。

```go
func (s *service) reloadOne(id string) error {
    if _, ok := s.catalog.Manifest(id); ok { return nil } // 已登记，幂等
    ... c.catalog.Add(manifest) // 不会替换旧登记
}
```

**改后**（同文件，返回 `reloaded|restarted|failed`）：`Stop(≤5s)` → `manager.Forget(id)`（instance 绑定旧 manifest，必须丢弃）→ 从 plugins bucket 取新版本 + 磁盘重读 info.json → `catalog.Replace`（保留 enabled）→ 按 `plugin_state.desired` 决定 `backend.Enable` 拉起；安装/重载失败显式 500。

配套：`registry.Catalog.Replace`（新增，Add 仍拒重复）、`supervisor.Manager.Forget`、installer 升级时保留 `desired_state`、`store/install` 响应新增 `reload` 字段。所有调用方共用 `reloadOne`，不存在只对安装端点生效的第二条路径。

## 2. 真机热升级证据（18877，不重启 kored）
| 步骤 | 结果 |
| --- | --- |
| 装 file 0.1.0（`package_path`） | 200 `state=succeeded, reload=reloaded` |
| `/plugins` | `version=0.1.0, enabled=false` |
| enable + `file.compress`（v1 无此方法） | enable 200；invoke **404 `E_NOTFOUND 未知方法: file.compress`** |
| 换 index 为 0.2.0 后装同 id v0.2.0（不带 force） | **200 `reload=restarted`** |
| `/plugins`（未重启） | **`version=0.2.0, desired=enabled`** |
| `file.compress`（升级后） | **200** `{"archive_path":"v2.zip","size_bytes":268,"entries":2,"format":"zip"}` |
| kored PID | 3889236 → 3889236（**未重启**）；插件进程由旧二进制换为新二进制（v1 404 → v2 200） |

## 3. P1 验签失败提示（旧公钥 kored + 新签名索引）
- 18878 用生产公钥二进制 + 测试密钥新签索引：`GET /store/plugins`、`/store/presets` 均 **401**。
- 错误体：`{"code":"E_UNAUTHORIZED","message":"索引签名校验失败：若刚更新过索引，需重启 kored 重新载入公钥","requires_restart":true,...}`；验签判定本身未改，只加结构化提示。
- 前端 `web/store.js`：命中 `requires_restart` 显示常驻醒目条「索引已更新，需重启 kored 才能载入新公钥」+ 折叠 `错误码`；普通错误条不再抢占。
- 截图断言：无登录表单、提示条 `display=block`、文案命中、`scrollWidth==innerWidth`（1440/390 无横向溢出）。

## 4. P1 同版本重装（force）
| 请求 | 结果 |
| --- | --- |
| 同版本不带 force | **409 `E_CONFLICT`**「该版本已安装；重装请带 force=true」 |
| 同版本 `force=true` | **200 `reload=restarted`**，`info.json` mtime `02:17:25.394` → `02:17:25.645`（payload 被替换） |
| 重装后插件 | `desired=enabled` 保留，`file.compress` 仍 200；`find *.bak-*` = **0**（成功后不残留备份） |
| 实现顺序 | 先停用 → installer 把旧目录改名为 `.bak-<纳秒>` → 安装 → 恢复 desired；安装失败回滚旧目录并把旧插件拉回 |

前端：已安装卡片显示「重装」，点击弹页面内二次确认「重装会覆盖当前安装目录，配置保留。」，确认后 `download=true&force=true`。
## 5. 门禁（命令 + 退出码）

- `go test -timeout 200s ./...` → **0**
- `make check` → **0**（10/10 段，含门禁全绿）
- `make frontend` → **0**（首屏 36758 B / 307200 B）
- `make docs-check` → **0**（6 pass / 0 warn / 0 fail）
- 新增回归：`TestReloadOneHotUpgradeSameID`（0.1.0→0.2.0，PID 变化、新方法可调）、`TestInstallForceReplacesSameVersion`、`TestCatalogReplaceSameID`、`TestInstallForceRoutes`、`TestSignatureErrorCarriesRestartHint`。

## 6. 双端截图（G-28，`file`/`identify` 实测）

| 文件 | 尺寸 | bytes | sha256(12) | 前后断言 |
| --- | --- | --- | --- | --- |
| hotfix-store-restart-notice-desktop.png | 1440x900 | 70390 | 6f613d9a4dbc | 前：无登录表单、条可见、error code 折叠；后：文案仍在 |
| hotfix-store-restart-notice-mobile.png | 390x844 | 55101 | bccb380adb79 | 前：无登录表单、无横向溢出；后：条可见 + 文案命中 |
| hotfix-reinstall-confirm-desktop.png | 1440x900 | 71960 | b3f8806cb49c | 前：已安装 v0.2.0、有「重装」、无确认框；后：确认框可见含「配置保留」 |

## 7. G-28 产品定位自评

① 重装让用户无需删除插件目录即可修复同版本安装，重启提示把“401 不知为何”变成“下一步重启 kored”；② 与宝塔/1Panel 差距：无卸载/回滚按钮、无进度条，重装需重新下载；③ **可用**（真实索引/真实包/真实进程，成功与失败路径均验证）。

## 8. 隔离、披露与清理

- 18877/18878 独立 state/run/log；**8787（PID 3769523）未重启、未触碰**。
- 验证用测试密钥二进制 `/tmp/.../kored-testkey` 仅替换内置公钥常量（`-overlay`，其余源码与 `bin/kored` 相同），用于在本地构造 0.1.0/0.2.0 两版本索引；生产 `bin/kored` 公钥未改。
- 验收后停止 18877/18878 与 chromium，删除 `/tmp/kore-verify-18877` 临时目录；仅保留截图与本报告。
