> 元信息: 2026-11-23T19:57+08:00 · 执行者 kore-impl-waf（implementer）· 对象 `web/dns.js`（提交 0cc0911）· 隔离实例 `/tmp/kore-dnsv`（端口 **18884**，未与 18882/18883 冲突）· 真机 chromium-1248 CDP · 报告 ≤70 行

# DNS 视图 G-28 双端证据

## 0. 结论

页面在真机渲染正常：状态卡显示**本机真实 DNS 服务**（systemd-resolved 259.9-0ubuntu0.1、127.0.0.53/54 四个监听、上游 6 个、系统解析器 127.0.0.53），
即时查询跑出**真实应答**（example.com A → 198.18.3.216，dig，9–28 ms），区域与记录两块是**本机真实的空态**（systemd-resolved 不存区域表）。
手机端 390px 无横向溢出、6/6 触摸目标 ≥44px。
**边界（必须一起读）**：本机没有 bind9/named，所以「区域列表/区域记录」只有空态，`E_NEED_ROOT` 这条降级分支**未被触发**，也没有截到——
本报告不把这两块说成"功能可用"，只证明「面板渲染 + 真实状态/查询 + 空态引导」成立。

## 1. 隔离实例（G-29 声明）

- 独立 `--config /tmp/kore-dnsv/config.yaml`，state/run/log 全在 `/tmp/kore-dnsv/{state,run,log}`，端口 18884。
- 本地包离线安装：`store/install {"id":"dns","version":"0.3.2","package_path":"…/kore-plugin-dns/dist/dns-0.3.2.tar.gz"}` → `state:succeeded`；
  该包 sha256 `a2953453…2a47` 与已签索引同值（未联网）。
- **主实例 8787 零写入**：本轮未读写 `.kore-local.yaml` / `.kore-local-state/` / `.kore-local-run/`，未重启主实例，未改 `bin/kored` 之外的运行态资产。
- 收尾：停实例 → 删 `/tmp/kore-dnsv` 整目录 → 18884 无监听（见 §5）。

## 2. 真实数据（截图即此状态）

| 区块 | 数据来源 | 截图里的值 |
| --- | --- | --- |
| 解析状态 `dns.status` | 本机真实探测 | 可用；主引擎 systemd-resolved · 259.9-0ubuntu0.1；监听 127.0.0.53:53/tcp·udp、127.0.0.54:53/tcp·udp；上游 2408:8899::8、223.5.5.5、223.6.6.6、2408:8888::8、fdfe:dcba:9876::2、198.18.0.2；候选 4 个引擎（dnsmasq 也 detected） |
| 即时查询 `dns.query` | 真实解析 | example.com / A → **198.18.3.216**，rcode NOERROR，TTL 1 秒，查询器 dig，9 ms（手机端 28 ms） |
| 区域列表 `dns.zones` | 真实扫描 | **0 个区域** + 后端 hint：「systemd-resolved 不存区域表…要托管区域请装 BIND9 或 dnsmasq」→ 页面给「打开 DNS 设置」按钮 |
| 区域记录 `dns.records` | 未触发（无区域） | 「先在上面区域表里点查看记录」空态 |

## 3. 截图（`file` 实测宽高）

| 文件 | 实际宽高 | sha256 前 16 | 画面 |
| --- | --- | --- | --- |
| `dns-view-desktop-01.png` | **1440 x 1040**（full-page） | `d05d3d14282f486a` | 进页态：真实状态卡（6 格）+ 即时查询表单 + 区域空态 + 记录空态；左栏「平台 · DNS 解析」高亮 |
| `dns-view-desktop-02.png` | **1440 x 1099**（full-page） | `89c5aff627fe3892` | 查询后：`1 条应答` 绿 chip + 耗时/查询器行 + 结果表（域名/类型/值/TTL = example.com · A · 198.18.3.216 · 1 秒） |
| `dns-view-mobile-01.png` | **390 x 844 视口 / 390 x 1620 full-page** | `d2a7c155189af63b` | 手机端：状态格纵向堆叠、查询表单整行、结果行按 `data-label` 还原列名（域名/类型/值/TTL）；6 个触摸目标全部 ≥44px，`scrollWidth == innerWidth` |

> 截图方法：chromium-1248 headless + 手写 CDP（`Emulation.setDeviceMetricsOverride` + `captureBeyondViewport`）；cookie 由 curl 登录后注入（一次性随机口令，仅存 `/tmp` 0600，已随目录删除）。
> 手机图里底部「概览/监控/…」tab 条出现在页面中部，是**固定底栏在 full-page 抓帧中的位置**（视口底 844px），不是布局错误。
> 本轮同时修了两处手机端排版并按新代码重拍：①「解析状态」标题被长副标题挤成两行 → 副标题缩为「只读探测」；②面板头在 390px 下允许换行、meta 允许折行（此前「即时查询」的说明被右边缘裁掉）。`node --check` / `make frontend` / `make build` 均 0。

## 4. 产品定位自评（G-28 三问）

**① 本页解决什么用户问题**：运维排查「域名解析不对/改了记录不生效/本机到底谁在应答」时，过去要 SSH 上去 `dig`、翻 `/etc/resolv.conf`、看 named.conf 里的 zone 块。
本页把三件事收进一屏：**谁在应答**（主引擎/监听/上游/系统解析器）、**现在解析成什么**（任意域名即时查询，结果带 rcode/耗时/查询器，能区分 NXDOMAIN 与超时）、**这台机器托管了哪些区域**（区域列表 → 记录只读表）。
取舍明确：写记录要 BIND9 动态更新 + TSIG 密钥，本页不做编辑入口，避免"点了才发现没配密钥"。

**② 与宝塔/1Panel 同类功能的差距**：差距在「托管」而不在「查看」。它们把 DNS 做成了**可编辑的权威管理台**——区域增删、记录增删改（A/CNAME/MX/TXT/SRV）、批量导入 zone 文件、解析生效检测、部分还带 DNSSEC 与解析日志报表；
本页只有：状态探测 + 即时查询 + 区域/记录**只读**呈现（写入靠插件 `record.add/update/delete`，需要先配 TSIG，未做成表单）。
对齐的部分：真实后端（不是 mock）、引擎无关（systemd-resolved/dnsmasq/bind9/coredns 同一套形状）、空态给下一步、双端适配。

**③ 当前是「可用」还是「占位」**：**状态卡与即时查询可用**（真机真数据：systemd-resolved 探测 + example.com 真实应答）；
**区域/记录两块在本机是空态，只能算「渲染正确 + 引导正确」，不能算功能可用**——本机没有 bind9/named，既没触发 `E_NEED_ROOT` 也没读到 zone 文件。
把结论写清楚：整页**不是占位**（两栏有真功能、两个空态有明确下一步），但「区域管理/记录编辑」这段能力在当前环境**未验证**。

## 5. 清理与门禁

```
$ curl -s -m 3 127.0.0.1:18884/-/healthz   # 截图时
{"status":"ok"}
$ kill <pid> && rm -rf /tmp/kore-dnsv
$ ss -ltn | grep 18884                      # 收尾后
(无输出)
$ file .agents/verify/screenshots/dns-view-*.png
1440 x 1040 / 1440 x 1099 / 390 x 1620
```

- 门禁：`node --check web/dns.js` **0**；`make frontend` **0**（34 文件 / 19 视图，首屏 59,709 ≤ 307,200 B，i18n 2,827 ≤ 3,072 B）；`make build` **0**。
- 未验证项：bind9 区域的真实记录表、`E_NEED_ROOT` 降级态、记录写入通道（需 TSIG 密钥）——三项都需要一台装了 bind9 的机器，本机不具备条件。
