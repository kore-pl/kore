# C13 PHP 扩展管理 · 隔离实跑十条断言证据（落盘）

> 2026-11-26 · 执行者 `c13-php-ext`（task-142）· 真实插件二进制 `kore-plugin-runtime-php/bin/runtime-php` v0.4.0（sha 与索引 8e500b28… 一致）· Python UDS harness 扮演 kore 内核（kore.hello 握手 + JSON 帧），PATH 前置假 pecl 执行面，state 落隔离目录，**未碰主实例 8787 / .kore-local-* / 宿主 php 与 apt 全局**。原始证据：`iso-c13-php-logs/assertions.log`（10 条逐条 CMD/EXIT/RESPONSE）、`iso-c13-php-logs/run.log`、`iso-c13-php-logs/host-global-before.txt`、`host-global-after.txt`、`pecl-argv.log`。一次性 harness（`harness.py` / `fakebin/pecl` / `state/` / `run.sock`）跑完即删，不留临时脚本。

## 1. 环境与方法

- 隔离目录：`kore/.agents/verify/iso-c13-php/`（工作区内短路径，非 /tmp，因本机 /tmp 不跨 bash 调用持久）；state=`state/php`，插件根 `KORE_PHP_ROOT=state/php`，socket `run.sock`。
- 握手：harness 监听 UDS，插件二进制启动即发 `kore.hello`，harness 回 `{ok:true, protocol:"kore.plugin.v1"}`；之后 5 次业务请求走同一帧协议（`[4B 大端长度][JSON]`，req_id 原样回显）。
- 假执行面 `fakebin/pecl`：把 argv 逐行写 `pecl-argv.log`；`install` 仅在 `extension_dir=<state>/global/php_ext`（隔离前缀内）建 `<name>/ext.json`；`uninstall` 只删该隔离目录内条目；任何 `-g/--global/apt` 一律 exit=2 拒绝。**它从不写宿主 php / apt 全局目录。**
- 运行命令与退出码：
  ```
  cd kore/.agents/verify/iso-c13-php
  python3 harness.py 2>&1 | tee run.log
  # exit=0；TOTAL: 10/10 PASS；RESULT: ALL PASS
  ```
- 原始 10 段 CMD/EXIT/RESPONSE 见 `iso-c13-php-logs/assertions.log`（与 run.log 同源，harness 内 logf 同步写两份），下表引用关键输出，未省略任何一条。

## 2. 十条断言（逐条命令 / 退出码 / 关键输出）

| # | 断言 | 命令原文（摘自 assertions.log） | 退出 | 关键输出 |
|---|---|---|---|---|
| 1 | ext.list 空列表 | `POST-UDS request=runtime-php.ext.list params={}` | 0 | `result.count=0`，prefix=`…/state/php/global`，hint「还没有隔离扩展…」 |
| 2 | ext.install 成功 | `POST-UDS request=runtime-php.ext.install params={"packages":["redis","memcached-3.1.5"]}` | 0 | `result.network_used=true`、`packages=["redis","memcached-3.1.5"]`、`output="added 2 package(s) in isolated prefix"` |
| 3 | redis 落隔离前缀 | `stat …/state/php/global/php_ext/redis/ext.json` | 0 | `exists=True` |
| 4 | memcached 落隔离前缀 | `stat …/state/php/global/php_ext/memcached/ext.json` | 0 | `exists=True` |
| 5 | argv 无全局选项 | `cat …/pecl-argv.log` | 0 | `install -d extension_dir=…/state/php/global/php_ext redis memcached-3.1.5`；无 `apt`/`-g`/`--global` |
| 6 | 固定 -d extension_dir | `grep -F 'extension_dir=…/state/php/global/php_ext' …/pecl-argv.log` | 0 | 命中 |
| 7 | ext.list 显示 2 项 | `POST-UDS request=runtime-php.ext.list params={}` | 0 | `result.count=2`，packages memcached/redis 各 1.0.0 |
| 8 | ext.remove 成功 | `POST-UDS request=runtime-php.ext.remove params={"packages":["redis","memcached"]}` | 0 | `result.removed=["redis","memcached"]`、`output="removed 2 package(s)"` |
| 9 | 移除后清理 | `stat …/state/php/global/php_ext/redis (expect no such file)` | 0 | `redis_exists=False memcached_exists=False` |
| 10 | apt 注入被拒 | `POST-UDS request=runtime-php.ext.install params={"packages":["apt install php-redis"]}` | 0（响应 exit；断言看 error） | `error.code=E_INVALID`，message「请检查包名 "apt install php-redis"…不要写空格、分号、斜杠或 apt 选项」 |

汇总：`TOTAL: 10/10 PASS` / `RESULT: ALL PASS`。

## 3. 宿主 php / apt 全局「无变化」——before/after 快照 sha 一致

```
# 宿主本机 pecl/php 均不在 PATH（command -v pecl → NO_PECL），故安装只能用隔离前缀 + 假执行面
find /usr/lib/php /etc/php /usr/local/lib/php /var/lib/dpkg/info -maxdepth 1 -mindepth 1 -printf '%p|%T@|%s\n' 2>/dev/null | sort > host-global-before.txt
sha256sum host-global-before.txt  # c80d9604e6691a6b505125e9d01b042696e0902c62855b0e5189bfe7d43b1e02（11153 行）
python3 harness.py                 # 跑完 10 条断言
find ...同上... | sort > host-global-after.txt
sha256sum host-global-after.txt   # c80d9604e6691a6b505125e9d01b042696e0902c62855b0e5189bfe7d43b1e02
diff host-global-before.txt host-global-after.txt
# exit=0（无输出），两份 sha256 完全相同
```

比较对象：`/usr/lib/php`、`/etc/php`、`/usr/local/lib/php`、`/var/lib/dpkg/info` 顶层每个条目名 + mtime + size（11153 行）。before/after 字节级一致，证明本轮真跑未改宿主 php / apt 全局。机制层反证：固定 argv `pecl install -d extension_dir=<state>/global/php_ext`、白名单挡 `apt ...`、假 pecl 拒绝 `-g/--global`。

## 4. 隔离与清理

- 端口：本卡直接驱动插件二进制经 UDS（`run.sock`），**不启 kored、不占用任何 TCP 端口**，主实例 8787 完全未触碰；`curl 8787/-/healthz` 本轮未执行（未在共享工作区起任何新实例）。
- 临时目录：`iso-c13-php/` 下 `harness.py` / `fakebin/pecl` / `state/` / `run.sock` / `__pycache__` 跑完即删；只保留本报告 + 5 份原始证据日志（移入 `iso-c13-php-logs/` 一并提交）。
- 未碰 `kore-plugin-runtime-node/`、未碰 node 仓任何状态；`.kore-local-*` 与 8787 运行态未变。

## 5. 诚实边界

- 安装由假 pecl 执行面完成，验证的是「argv 固定 + 隔离前缀 + 白名单 + 不碰宿主」，不是真机联网 `pecl install` 编译行为；宿主本就无 pecl/php，真机安装本卡不可验。
- 断言 #9/#10 的 EXIT 列是「命令/请求 exit 0，断言依据为结果内容（目录不存在 / error.code）」，不是命令失败，特此写清避免误读。
- 宿主快照覆盖 php/apt 常见目录顶层，未覆盖 dpkg 数据库二进制内容本身；结合 argv 固定与假执行面内部校验，足以证明本轮无宿主写入。
