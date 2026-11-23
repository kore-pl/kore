# discover 视图 G-28 双端截图（重拍，2026-11-23 23:40–23:55）

## 0. 为什么重拍

`caa582e` 的 discover 截图拍的是旧构建（自述「用的是 `bin/kored`（22:03 由我的树构建），而 `discover-finish` 随后提交了 `0cd5dab`（与我截图那版不同），**重新构建后需重拍**」），且当时 CSRF 缺失、数据层全空。

本轮触发条件已全部具备：

- `0cd5dab`（`web/discover.js`，493 行）已提交；本轮核验 `web/dist/discover.js` 与源文件 `diff` 一致（23:40 打包）。
- `d553cd1` 修 CSRF 幂等补发；`a68c4b1` 恢复面板登录门（ADR-0043）。
- 隔离二进制由 **HEAD `ec883d4` 归档** 构建（含上述全部修复与新版 discover 视图）。

## 1. 隔离环境（主实例 8787 零改动）

```text
命令: git archive HEAD | tar -x -C /tmp/kore-discover-reshoot/src && make web-dist
命令: CGO_ENABLED=0 GOAMD64=v1 go build -trimpath -buildvcs=false -ldflags '-s -w' -o /tmp/kore-discover-reshoot/bin/kored ./cmd/kored
退出码: 0
二进制: /tmp/kore-discover-reshoot/bin/kored  10420386 bytes

命令: ss -ltn | grep ':18869 '
输出: （空）→ 端口空闲
命令: /tmp/kore-discover-reshoot/bin/kored serve --config /tmp/kore-discover-reshoot/config.yaml
输出: {"msg":"kore ready","pid":1585244,"version":"0.1.0","socket":"/tmp/kore-discover-reshoot/run/kore.sock","addr":"127.0.0.1:18869"}
```

- 独立 config / state / run / log 全部落 `/tmp/kore-discover-reshoot/`；`paths.index_dir` = `/home/pt/Work/GolandProjects/kore-plugins/index`（只读指向索引仓）。
- 构建走 `git archive HEAD` 而不是工作区：本轮工作区存在其他 agent 在途改动（`internal/platform` 出现 `userdelCandidates` 重复声明，`go build` exit 1），为避免把别人的半成品编进证据、也不修改共享树，改从 HEAD 归档构建。
- **主实例 8787 未重启、未改配置、未改 `bin/kored`**：`ps -o pid,lstart -p 1387457` 仍为 `23:24:57` 启动；`bin/kored` mtime 仍为 `23:21:52`；`curl -s 127.0.0.1:8787/-/healthz` → `{"status":"ok"}`。

## 2. 登录门（真实走登录页）

```text
命令: curl -s -i -X POST http://127.0.0.1:18869/api/v1/auth/login -H 'Content-Type: application/json' --data '{"password":"***"}'
退出码: 0（HTTP 200）
输出: Set-Cookie: kore_session=<43 chars>; Path=/; Max-Age=7200; HttpOnly; SameSite=Strict
      Set-Cookie: kore_csrf=<43 chars>; Path=/; Max-Age=7200; SameSite=Strict
      {"authenticated":true,"expires_at":"2026-11-23T17:45:18Z"}
命令: curl -s -b cookies http://127.0.0.1:18869/api/v1/auth/session
输出: {"authenticated":true,"expires_at":"2026-11-23T17:45:18Z"}
```

浏览器侧不注入 cookie，走 `web/app.js` 登录表单（`#kore-password` → `POST /api/v1/auth/login`）；登录后 discover 视图的 `POST /api/v1/invoke/discover/*` 均带 `X-Kore-CSRF`（值取自 `kore_csrf` cookie），真实模式下页面无 403/401。

## 3. 安装 discover（索引版本 0.3.1）

```text
索引: kore-plugins/index/plugins.json → discover 0.3.1
      sha256=972d932b08797e7f96bf8e54ad49631e9151e9818f47c6bf48a4fe46502df165
本地包: kore-plugin-discover/dist/discover-0.3.1.tar.gz
      sha256=972d932b08797e7f96bf8e54ad49631e9151e9818f47c6bf48a4fe46502df165  ← 与索引摘要一致

命令: curl -b cookies -H 'X-Kore-CSRF: <csrf>' -X POST http://127.0.0.1:18869/api/v1/store/install \
      --data '{"id":"discover","version":"0.3.1","package_path":".../discover-0.3.1.tar.gz"}'
输出: {"id":"discover-0.3.1","plugin_id":"discover","version":"0.3.1","state":"succeeded","message":"安装完成","reload":"reloaded"}
命令: curl -b cookies -H 'X-Kore-CSRF: <csrf>' -X POST http://127.0.0.1:18869/api/v1/plugins/discover/enable
输出: {"id":"discover","version":"0.3.1","lifecycle":"lazy","state":"stopped","desired":"enabled","enabled":true,
      "granted_capabilities":["system:read","proc:read"]}
```

## 4. API 真实返回（UI 数据来源）

```text
命令: POST /api/v1/invoke/discover/discover.summary
输出: {"ready":true,"web_server":"nginx","db":"mariadb",
      "conclusion":"本机已就绪：检测到 Nginx 与 MariaDB，可直接安装站点与数据库插件。",
      "suggestions":[{"plugin":"site",...},{"plugin":"db-mysql",...},{"plugin":"redis",...},
                     {"plugin":"container",...},{"plugin":"runtime-node",...},{"plugin":"runtime-python",...},
                     {"plugin":"cron",...},{"plugin":"firewall",...}]}   ← 8 条建议

命令: POST /api/v1/invoke/discover/discover.services
输出: 22 项探测，found=true 10 项：
      nginx / mariadb / redis / node / python3 / docker / crontab / systemctl / ufw / iptables

命令: POST /api/v1/invoke/discover/discover.ports
输出: 105 条，listening=true 105 条；process 非空 63 条、process=null 42 条（非 root 只能看同 uid socket）
前 6 条: [{"port":22,"addr":"0.0.0.0","family":"ipv4","listening":true,"process":null},
         {"port":22,"addr":"::","family":"ipv6","listening":true,"process":null},
         {"port":53,"addr":"127.0.0.53","family":"ipv4","listening":true,"process":null},
         {"port":53,"addr":"127.0.0.54","family":"ipv4","listening":true,"process":null},
         {"port":53,"addr":"192.168.122.1","family":"ipv4","listening":true,"process":null},
         {"port":631,"addr":"127.0.0.1","family":"ipv4","listening":true,"process":null}]
```

浏览器侧同源复核（页面内 fetch 上述方法后与 DOM 对账）：

```text
apiPorts=105 apiListening=105 apiServices=22 apiFound=10 apiSummaryReady=true
uiRowCount(端口表)=105   uiServicesRows=10
uiMetricTexts=["已检测服务10 个 共探测 22 项","在听端口105 个 …","Web 服务器nginx","数据库mariadb","容器运行时已检测到 Docker"]
```

> 对账注意：`table.disc-table` 同时用于「监听端口」与「服务清单」两张表，朴素选择器数出 115 行 = 端口 105 + 服务 10；按容器限定 `.disc-ports table.disc-table tbody tr` 为 105 行。

## 5. 截图证据（`file` 实测宽高）

```text
命令: file .agents/verify/screenshots/discover-*.png
退出码: 0
输出:
discover-nav-desktop-01.png:         PNG image data, 1440 x 900
discover-nav-mobile-01.png:          PNG image data, 390 x 844
discover-overview-desktop-01.png:    PNG image data, 1440 x 6389
discover-overview-mobile-01.png:     PNG image data, 390 x 19933
discover-ports-desktop-01.png:       PNG image data, 1440 x 3719
discover-ports-mobile-01.png:        PNG image data, 390 x 10549
discover-degraded-desktop-01.png:    PNG image data, 1440 x 900
discover-degraded-mobile-01.png:     PNG image data, 390 x 844
```

| 场景 | 桌面（1440×900，full-page） | 手机（390×844） | 达标依据 |
| --- | --- | --- | --- |
| ① 导航入口 | `discover-nav-desktop-01.png`（侧栏滚动到底，末项「服务发现」可见） | `discover-nav-mobile-01.png`（「更多」抽屉，选中态高亮，视口 390×844） | 桌面端导航项在 900px 高下位于侧栏末尾，需滚动侧栏；手机端在「更多」抽屉内 |
| ② 概览真实数据 | `discover-overview-desktop-01.png` | `discover-overview-mobile-01.png` | 「本机已就绪」徽标 + 结论原文 + 已检测服务 10 个/共探测 22 项 + 在听端口 105 个 + nginx/mariadb/Docker + 8 条建议 |
| ③ 端口表有行 | `discover-ports-desktop-01.png`（过滤 `127.0.0.1`：在听 105、匹配 45，前几行 631/1053/4001/4222/4301…） | `discover-ports-mobile-01.png`（同过滤，移动端卡片式行布局） | 表格行来自 `discover.ports`，未过滤时 105 行；过滤态便于在一屏内核对表头与行内容 |
| ④ 降级态（未装插件） | `discover-degraded-desktop-01.png` | `discover-degraded-mobile-01.png` | 标题「还没有安装「服务发现」插件」+ 按钮「去软件商店安装」（代码原文为「去软件商店安装」，即验收口径的「去商店安装」） |

③ 为什么用过滤态截图：端口表默认 105 行、整页 6389px 高，单张 full-page 里表格行过密；过滤 `127.0.0.1` 后仍保留 45 行真实数据，表头/行内容/过滤计数（在听 105 个，匹配 45 个）同屏可核对。未过滤的真实行数与内容见 §4 API 返回。

## 6. 自评三问（G-28）

1. **这页替用户解决什么问题**：装完 Kore 后「这台机器上已经装了什么、哪些端口在听、下一步该装哪些插件」不需要逐条 shell 排查——概览把命中服务、在听端口计数、可装插件建议合成一屏，端口与服务清单可下钻核对。
2. **与宝塔 / 1Panel 同类功能的具体差距**：①宝塔「软件商店」把服务版本、启停、配置编辑做成一体，本页只读，不能启停或改配置；②1Panel「主机」有实时资源指标与端口→应用归属映射，本页端口归属靠 `services[].port` 反查，105 条里 42 条进程名为空、归属多数「未识别」（非 root 读不到别的 uid socket），缺一条授权后补全进程名的提权路径；③无历史趋势/变更对比；④建议项只能跳商店，不能一键安装。
3. **当前是「可用」还是「占位」**：**可用**——只读发现场景闭环（真实数据、登录门后可用、双端布局、过滤、四类降级分支都通）。缺口集中在「发现→处置」这一跳（启停服务 / 提权补全进程名 / 建议一键安装），列为下一步，不算占位。

## 7. 未达成项与限制（如实记录）

- 端口 `process` 42/105 为空：隔离实例以普通用户运行（启动日志 `kored 非 root：插件降权未生效`），插件按设计只读同 uid socket，UI 以「—」+ tooltip 呈现，不是截图失败。
- 隔离实例只装了 discover，主壳「概览」页的 `monitor.system` / `site.list` / `ssl.list` 探测 404（页面明示「monitor 插件未启用，指标为内核采样降级值」），属本实例插件面不全，与 discover 页无关；真实模式下 discover 页自身无 404。
- ① 桌面入口截图需滚动侧栏（900px 高下末项在折线下），已在截图与本节说明，不是裁剪或缩放。

## 8. 清理

```text
命令: kill 1585244 && sleep 1 && ss -ltn | grep ':18869 '
输出: （空）→ 端口释放，插件的 lazy 进程随之退出
命令: rm -rf /tmp/kore-discover-reshoot
```

一次性脚本（`shoot.js` / `check.js` / `navshot.js` / `mobiletop.js`）全部落在 `/tmp` 并随目录删除，未进工作区。
