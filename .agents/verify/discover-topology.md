# discover 服务发现 · 拓扑关系 / 服务目录 / 变化提示 验收

> 执行者: [agent:resume-discover] · 2026-11-25 12:40–12:45 +08:00 · 隔离实例（动态端口，state/run/log 全在 /tmp，收尾已删）
> 结论: **可用**。关系视图、服务目录、与上次扫描对比三块都在真实数据下渲染；跳转按钮经真机点击验证落点正确；增强数据缺失时按「取不到就整块降级」显示、不阻塞主清单。

## 1. 门禁命令（命令 + 退出码）

```text
$ cd kore-plugin-discover && GOWORK=off go test -timeout 200s ./...
ok  github.com/pengtang1024/kore-plugin-discover            0.003s
ok  github.com/pengtang1024/kore-plugin-discover/internal/probe   2.422s
ok  github.com/pengtang1024/kore-plugin-discover/tests/boundary   0.065s
ok  github.com/pengtang1024/kore-plugin-discover/tests/e2e        0.329s
ok  github.com/pengtang1024/kore-plugin-discover/tests/fault      0.005s
exit=0        # 仓内另有他人未跟踪的 zeroparam_test.go，随 ./... 一起编译通过，本轮未改动该文件

$ node --check kore/web/discover.js
[OK] exit=0

$ cd kore && make secret-check
secret-check: 0 FAIL / 22 处匹配（占位写法均合规）
exit=0

$ bash scripts/frontend-check.sh        # 在 HEAD 归档 + 本轮 web/discover.js 的临时树内跑
[OK] dist 无 source map / .vite / 全量字体
[INFO] 首屏合计（gzip -9）: 81528 字节 / 预算 307200 字节（300 KiB）
exit=0        # discover.js 是懒加载视图模块，不进首屏六件套
```

## 2. 隔离实例与数据（主实例 8787 零写入、未重启）

- 二进制由 `git archive HEAD` 归档 + 覆盖本轮 `web/discover.js` 构建（不把他人未提交的 Go 改动编进证据），`make web-dist` 后 `cmp` 校验 dist 与源一致。
- 装入本地 dist 包：discover 0.3.1 / process 0.3.0 / container 0.5.5，`paths.index_dir` 只读指向 `kore-plugins/index`；三个插件均 install=enabled 成功。
- 真实数据：8 个已检测服务 / 4 个类型分组 / 8 行服务目录 / 127 个在听端口 / 8 张关系卡；容器归属命中 2 处（:3306 common-mysql、:6379 common-redis）。
- 变化提示：临时监听套接字 → 刷新后出现「新增端口 1 个」与绿色「新增」标记；关闭后再次刷新显示「消失端口 1 个」与划线「消失」标记（无 mock、无造数）。

## 3. 真机点击（Playwright chromium headless，1440×900 / 390×844）

| 点击 | 结果 | 落点 |
| --- | --- | --- |
| 关系视图「去进程页看全部端口」 | ok | `#/monitor/process` |
| 数据库卡「打开数据库」 | ok | `#/db/db` |
| 关系卡「看容器」 | ok | `#/sites/container` |
| 端口过滤输入 `<实例端口>` | ok | 行内容 `40913 / IPv4 / 进程 kored / kored · 179 / — / 127.0.0.1`（端口→进程/PID 这一列是活的） |
| 「显示更多」 | ok | 端口表 20 行 → 40 行（有界 + 分页展开，还剩 108 个） |

手机端：390 宽下 `document.scrollWidth == clientWidth == 390`（无横向溢出），目录表按 `data-label` 转卡片行、关系卡单列、跳转按钮触摸高度 44px。
页面 `pageerror` = 0；浏览器侧 4xx 只有概览页对未装插件（monitor/site/ssl）的探测 404 与登录前 `/system/info` 401，**不是本页调用**。

## 4. 截图（`identify` 实测宽高）

| 文件 | 实测 | 场景 |
| --- | --- | --- |
| `discover-topology-desktop-01.png` | 1440×3995 | PC 全页：概览 + 变化提示（新增端口）+ 关系视图 + 服务目录 + 端口表 |
| `discover-topology-desktop-02.png` | 1086×831 | 关系卡特写：服务 → 端口 → 进程/容器 |
| `discover-topology-desktop-03.png` | 1440×3995 | PC 全页：关闭监听后「消失端口」标记 |
| `discover-topology-desktop-04.png` | 1086×87 | 端口过滤到实例端口：`kored · 179`（PID 列有值） |
| `discover-topology-mobile-01.png` | 390×9529 | 手机全页（390×844 视口，20 行上限） |
| `discover-topology-mobile-02.png` | 364×1237 | 手机关系卡特写（单列 + 44px 按钮） |
| `discover-topology-mobile-03.png` | 390×844 | 手机首屏（概览 + 变化提示） |

## 5. 已知限制（如实记录，非本页缺陷）

隔离 `kored` 跑在 harness 的 bubblewrap 沙箱里，`/proc` 只暴露自身 7 个进程；宿主上的 root 服务（docker-proxy 转发的 3306、宿主 redis 的 6379）既看不到 PID 也读不到进程名，所以「进程 / PID / 运行时长 / 资源占用」这些列对多数服务显示「—」并附「其余端口需要管理员权限（root）才能读取进程」的说明——不是编一个假值。PID 链路本身的正确性由第 3 节的端口过滤行证明（`kored · 179` 来自 process.ports + process.list/process.detail）。在真实宿主机上以 root 启动 kored 后，这些列会自然补齐。

## 6. G-28 ③ 自评三问

1. **解决什么用户问题**：不用 ssh 逐条 `ss`/`ps` 对照，就能看清「谁在监听哪个端口、属于哪个服务或容器、和上次比多了/少了什么」，并直接跳到进程 / 容器 / 数据库页处理。
2. **与宝塔 / 1Panel 差距**：宝塔把已装环境折进软件商店，1Panel 有独立主机页；本页多出「端口 → 进程 → 容器」关系与本地变化对比，但**没有历史趋势、没有端口变更告警**（变化只在本浏览器 localStorage 里对比、不上报），也没有大图谱（按 FRONTEND 关系优先做分组卡片，不引图表库）。
3. **当前是「可用」还是「占位」**：**可用**——三块内容都是真实探测结果，跳转可用，增强数据缺失时诚实降级；受宿主权限限制的列显示「—」并说明原因。

## 7. 运行态与清理（G-29）

- 主实例 8787：零写入、未重启、未改配置；未触碰 `.kore-local*` / `bin/kored`。
- 隔离实例：独立 `--config`，state/run/log 全在 `/tmp`；收尾 TERM 实例并删除构建树与运行目录，未在工作区留临时脚本。
- 本轮改动域：仅 `kore/web/discover.js`（未改 shell.js / onboarding.js / 其他插件仓 / 后端）。
