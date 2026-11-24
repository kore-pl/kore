# R10-7 i18n key 清单（四视图，交下游 en-US 收口卡）

| key | 中文原值 | 所在文件:行 |
| --- | --- | --- |
| redis.err.noCsrf | 缺少 CSRF 令牌，请刷新页面或重新登录 | redis.js:58 |
| redis.err.timeoutPrefix | 请求超时（ | redis.js:73 |
| redis.ttl.never | 永不过期 | redis.js:85 |
| redis.hint.auth | 请确认 Redis 密码，可在 /etc/redis/redis.conf 的 requirepass 查看； | redis.js:165 |
| redis.hint.authDocker | Docker 启动的 Redis 看容器命令里的 --requirepass 或 REDIS_PASSWORD 环境变量。 | redis.js:166 |
| redis.hint.refused | Redis 未在目标端口监听：确认服务已启动（systemctl status redis-server）， | redis.js:169 |
| redis.hint.dockerPort | Docker 用 docker ps 核对端口映射。 | redis.js:170 |
| redis.hint.host | 主机名无法解析：本机 Redis 请填 127.0.0.1，远程服务请填可解析的 IP 或域名。 | redis.js:173 |
| redis.hint.generic | 检查地址、端口和密码，确认 Redis 已启动并允许从本机连接，然后重试。 | redis.js:175 |
| redis.badge.connected | 已连接 | redis.js:194 |
| redis.detect.connTrust1 | 服务端版本来自已连通的连接（用配置里的凭据真实连上服务端），比本机自动检测更可信； | redis.js:197 |
| redis.detect.connTrust2 | 自动检测只探到客户端版本时以这里为准。连接信息可在右上角「设置」里修改。 | redis.js:198 |
| redis.btn.editConn | 修改连接 | redis.js:202 |
| redis.btn.redetect | 重新检测 | redis.js:203 |
| redis.badge.detect | 自动检测 | redis.js:208 |
| redis.detect.loading | 正在检测本机 Redis… | redis.js:209 |
| redis.detect.readonly | 检测只读本机命令与监听端口，不会安装或启动任何服务。 | redis.js:210 |
| redis.badge.detectFail | 自动检测不可用 | redis.js:215 |
| redis.detect.failed | 未能完成自动检测 | redis.js:216 |
| redis.label.reason | 原因： | redis.js:217 |
| redis.btn.manualConfig | 手动配置 | redis.js:219 |
| redis.detect.notFound | 未检测到本机 Redis | redis.js:226 |
| redis.detect.install1 | 安装服务后刷新本页会自动识别。Debian/Ubuntu：sudo apt install redis-server； | redis.js:227 |
| redis.detect.install2 | RHEL：sudo dnf install redis。已有远程 Redis 可直接手动配置。 | redis.js:228 |
| redis.detect.notRunningSuffix | ，但服务未运行 | redis.js:243 |
| redis.detect.startHint | 启动服务后再点“重新检测”：systemctl start redis-server（或 redis）。 | redis.js:244 |
| redis.detect.autoOk | 已自动填入主机、端口并连接成功；可在右上角「设置」里修改连接信息。 | redis.js:256 |
| redis.detect.autoClient | 已自动填入主机、端口；点“一键连接”后只需填写密码。 | redis.js:257 |
| redis.btn.oneClick | 一键连接 | redis.js:261 |
| redis.detect.clientOnly | 检测到本机 Redis 客户端（未连上服务端，需要密码） | redis.js:268 |
| redis.detect.clientNoVer | 客户端，未拿到版本号 | redis.js:269 |
| redis.detect.clientSuffix | ，没有连上服务端；连上真实服务端后这里会显示服务端版本。 | redis.js:270 |
| redis.empty.loadFail | 读取连接失败 | redis.js:291 |
| redis.label.howto | 怎么办： | redis.js:293 |
| redis.btn.reload | 重新读取 | redis.js:294 |
| redis.empty.noConn | 还没有 Redis 连接 | redis.js:300 |
| redis.detect.loadingInline | 正在检测本机 Redis…检测完成后这里会出现一键连接入口。 | redis.js:303 |
| redis.empty.detected | 已检测到本机 Redis | redis.js:308 |
| redis.empty.detectedSuffix | 。点上方“一键连接”，只需填写密码即可。 | redis.js:308 |
| redis.empty.notRunningLong | 检测到本机 Redis，但服务未运行。启动服务后点上方“重新检测”。 | redis.js:310 |
| redis.empty.notFoundLong | 未检测到本机 Redis。安装后刷新本页会自动识别：Debian/Ubuntu 用 sudo apt install redis-server，RHEL 用 sudo dnf install redis。 | redis.js:312 |
| redis.label.defaultConn | 默认连接 | redis.js:329 |
| redis.badge.reachable | 可达 | redis.js:330 |
| redis.badge.unreachable | 不可达 | redis.js:330 |
| redis.label.verUnknown | 版本未知 | redis.js:332 |
| redis.label.connFail | 连接失败： | redis.js:334 |
| redis.label.reasonUnknown | 原因未知 | redis.js:334 |
| redis.err.infoFail | 信息读取失败： | redis.js:358 |
| redis.status.infoLoading | 正在读取连接信息… | redis.js:359 |
| redis.stat.version | 服务版本 | redis.js:363 |
| redis.stat.uptime | 运行时长 | redis.js:363 |
| redis.stat.clients | 客户端连接 | redis.js:363 |
| redis.stat.tcpPort | TCP 端口 | redis.js:364 |
| redis.stat.memUsed | 内存使用 | redis.js:364 |
| redis.stat.memPeak | 内存峰值 | redis.js:365 |
| redis.stat.maxMem | 最大内存 | redis.js:365 |
| redis.stat.unlimited | 不限制 | redis.js:365 |
| redis.stat.hitRate | 命中率 | redis.js:366 |
| redis.keyspace.none | 没有任何键 | redis.js:373 |
| redis.delete.keys |  个键 | redis.js:376 |
| redis.btn.deleteSelPrefix | 删除选中（ | redis.js:386 |
| redis.btn.deleteSel | 删除选中 | redis.js:386 |
| redis.footer.shown | 已显示  | redis.js:396 |
| redis.footer.atLeast |  / 至少  | redis.js:396 |
| redis.footer.of |  / 共  | redis.js:397 |
| redis.btn.loading | 加载中… | redis.js:400 |
| redis.btn.loadMore | 加载更多 | redis.js:400 |
| redis.footer.limitReached | （已达查询上限，可调大「上限」后重新查询） | redis.js:404 |
| redis.key.loaded | 已加载  | redis.js:410 |
| redis.key.truncated | （结果被截断） | redis.js:411 |
| redis.err.scanFail | 扫描键失败： | redis.js:413 |
| redis.status.keysScanning | 正在扫描键… | redis.js:414 |
| redis.empty.noMatch | 没有匹配的键 | redis.js:417 |
| redis.empty.dbEmpty | 这个库是空的 | redis.js:417 |
| redis.empty.matchPrefix | 当前匹配「 | redis.js:418 |
| redis.empty.matchSuffix | 」没有命中；换个通配符，或清空匹配看全部键。 | redis.js:418 |
| redis.empty.dbEmptyText | 当前 DB 里一个键也没有；写入数据后这里会自动出现。 | redis.js:418 |
| redis.btn.reloadKeys | 重新读取键列表 | redis.js:419 |
| redis.key.selectAll | 全选当前页键 | redis.js:429 |
| redis.col.key | 键名 | redis.js:437 |
| redis.col.type | 类型 | redis.js:437 |
| redis.col.ttl | TTL | redis.js:437 |
| redis.key.select | 选择键 {key} | redis.js:444 |
| redis.ops.memUsed | 内存用量 | redis.js:493 |
| redis.label.readFail | 读取失败 | redis.js:496 |
| redis.ops.evictPolicy | 淘汰策略： | redis.js:502 |
| redis.ops.noMax | 未设上限（maxmemory=0） | redis.js:507 |
| redis.ops.frag | 内存碎片率 | redis.js:511 |
| redis.ops.fragHigh | 偏高（≥1.5），关注淘汰与内存交换 | redis.js:518 |
| redis.ops.fragNormal | 正常（<1.5） | redis.js:518 |
| redis.ops.fragNone | 服务端未返回碎片率 | redis.js:519 |
| redis.ops.aofRdb | AOF / RDB | redis.js:522 |
| redis.ops.aofOk | 开启 · 写入正常 | redis.js:529 |
| redis.ops.aofBad | 开启 · 写入异常 | redis.js:529 |
| redis.ops.aofOff | 关闭 | redis.js:529 |
| redis.ops.aofWarn | AOF 最近一次写入状态异常，可能丢数据 | redis.js:530 |
| redis.ops.bgsaving | RDB BGSAVE 进行中 | redis.js:531 |
| redis.ops.rdbLast | RDB 上次保存  | redis.js:532 |
| redis.ops.rdbTime | 上次保存时刻  | redis.js:532 |
| redis.ops.unsaved | 未落盘变更  | redis.js:533 |
| redis.btn.bgsaving | 触发中… | redis.js:534 |
| redis.btn.bgsave | 立即落盘（BGSAVE） | redis.js:534 |
| redis.ops.slow24h | 慢查询（24h） | redis.js:539 |
| redis.ops.slowBuf | 缓冲区共  | redis.js:547 |
| redis.ops.slowDetail |  条 · 明细见下方「慢查询」 | redis.js:547 |
| redis.slow.note | 仅记录执行时间超过 slowlog-log-slower-than（默认 10000µs = 10ms）的命令；缓冲区上限 slowlog-max-len（默认 128）条，读取时可能被截断。本页只读，不改动慢日志配置。 | redis.js:568 |
| redis.err.slowFail | 慢查询读取失败： | redis.js:569 |
| redis.status.slowLoading | 正在读取慢查询… | redis.js:570 |
| redis.slow.empty | 暂无慢查询记录——所有命令都在阈值之内。 | redis.js:572 |
| redis.col.time | 时间 | redis.js:576 |
| redis.col.duration | 耗时 | redis.js:576 |
| redis.col.command | 命令 / 参数 | redis.js:576 |
| redis.err.keyInfoFail | 键详情读取失败： | redis.js:636 |
| redis.status.keyInfoLoading | 正在读取键详情… | redis.js:639 |
| redis.detail.encoding | 编码 | redis.js:641 |
| redis.detail.noEncoding | （服务端未返回） | redis.js:641 |
| redis.detail.mem | 内存占用 | redis.js:642 |
| redis.detail.memHint | 内存占用含键与值的结构与数据（MEMORY USAGE 采样估算）。 | redis.js:647 |
| redis.detail.memNone | 服务端未返回内存占用（MEMORY USAGE 需 Redis ≥ 4.0）。 | redis.js:648 |
| redis.btn.rereadValue | 重新读取值 | redis.js:650 |
| redis.btn.readValue | 读取值 | redis.js:650 |
| redis.label.ttl | 过期时间 | redis.js:653 |
| redis.ttl.1h | 1 小时 | redis.js:654 |
| redis.ttl.1d | 1 天 | redis.js:654 |
| redis.ttl.7d | 7 天 | redis.js:654 |
| redis.ttl.persist | 永久（清除过期） | redis.js:657 |
| redis.detail.valueNote | 读取值可能带来大对象传输，默认不自动执行。 | redis.js:658 |
| redis.value.notRead | 未读取值——点上方「读取值」查看内容。 | redis.js:674 |
| redis.err.valueFail | 读取值失败： | redis.js:675 |
| redis.status.valueLoading | 正在读取值… | redis.js:676 |
| redis.value.empty | （空值） | redis.js:678 |
| redis.col.field | 字段 | redis.js:681 |
| redis.col.value | 值 | redis.js:681 |
| redis.value.emptyHash | （空 hash） | redis.js:681 |
| redis.col.member | 成员 | redis.js:684 |
| redis.value.emptyPrefix | （空  | redis.js:684 |
| redis.col.score | 分值 | redis.js:687 |
| redis.value.emptyZset | （空 zset） | redis.js:687 |
| redis.value.truncated | 集合类最多显示前 100 项 | redis.js:689 |
| redis.type.string | 字符串 string | redis.js:695 |
| redis.type.stringHint | 整段文本，写入即 SET（覆盖原值） | redis.js:695 |
| redis.type.hash | 哈希 hash | redis.js:696 |
| redis.type.hashHint | 每行「字段=值」，写入 HSET | redis.js:696 |
| redis.type.list | 列表 list | redis.js:697 |
| redis.type.listHint | 每行一个元素，追加到 RPUSH 尾部 | redis.js:697 |
| redis.type.set | 集合 set | redis.js:698 |
| redis.type.setHint | 每行一个成员，SADD | redis.js:698 |
| redis.type.zset | 有序集合 zset | redis.js:699 |
| redis.type.zsetHint | 每行「成员=分值」，分值必须是数字 | redis.js:699 |
| redis.ttl.none | 不设置过期 | redis.js:702 |
| redis.err.needElement | 至少填一个元素（每行一个） | redis.js:722 |
| redis.err.badPair |  行缺少「=」：格式是「字段=值」 | redis.js:726 |
| redis.err.needMemberScore | 至少填一个「成员=分值」 | redis.js:727 |
| redis.err.needFieldValue | 至少填一个「字段=值」 | redis.js:727 |
| redis.err.badScore |  个分值不是数字：zset 的「成员=分值」右侧必须是数字 | redis.js:733 |
| redis.set.keyPlaceholder | 例如 kore:demo:cache | redis.js:753 |
| redis.set.valueLabel | 值 ·  | redis.js:777 |
| redis.set.placeholderString | 任意文本 | redis.js:781 |
| redis.set.placeholderEach | 每行一个元素 | redis.js:784 |
| redis.btn.writing | 写入中… | redis.js:787 |
| redis.btn.write | 写入 | redis.js:787 |
| redis.set.note | 写入会覆盖同键的旧值（字符串 SET / 集合增量写）；一次写入的元素数与单值字节由后端上限约束。 | redis.js:791 |
| redis.set.ttlApplied |  写入后设置过期： | redis.js:792 |
| redis.err.writeFail | 写入失败： | redis.js:794 |
| redis.hint.readonly | 当前连到的是只读副本（replica）：请切换到主节点再写 | redis.js:800 |
| redis.hint.noPerm | 当前账号没有写权限：请用有 SET/HSET/RPUSH/SADD/ZADD 权限的账号连接 | redis.js:801 |
| redis.hint.oom | Redis 内存已满（maxmemory）：先扩容或在「服务端配置」里调整淘汰策略 | redis.js:802 |
| redis.hint.invalid | 键名或值不合法：键名不能为空，元素数与单值字节需在后端上限内 | redis.js:803 |
| redis.err.keyEmpty | 键名不能为空 | redis.js:810 |
| redis.set.done | 已写入  | redis.js:819 |
| redis.err.ttlFail | 设置过期失败： | redis.js:839 |
| redis.err.persistFail | 清除过期失败： | redis.js:851 |
| redis.bgsave.done | 已触发 BGSAVE： | redis.js:861 |
| redis.bgsave.started | 后台落盘已开始 | redis.js:861 |
| redis.bgsave.note | （完成状态见 AOF/RDB 卡片） | redis.js:861 |
| redis.err.bgsaveFail | 触发 BGSAVE 失败： | redis.js:867 |
| redis.hint.cfgUnsupported1 | 该参数需改 redis.conf：本页只允许热改 maxmemory / maxmemory_policy / timeout， | redis.js:888 |
| redis.hint.cfgUnsupported2 | dir / appendonly / requirepass / save 等必须写配置文件并重启 Redis | redis.js:889 |
| redis.hint.cfgInvalid1 | 值不合法：maxmemory 只接受字节整数或 kb/mb/gb 后缀（0 = 不限制），策略必须是 8 种之一， | redis.js:892 |
| redis.hint.cfgInvalid2 | timeout 必须是非负整数秒（0 = 不断开空闲连接） | redis.js:893 |
| redis.hint.cfgDisabled1 | Redis 禁用了 CONFIG 命令（rename-command 或 ACL）：请在 redis.conf 里启用 CONFIG， | redis.js:896 |
| redis.hint.cfgDisabled2 | 或改用允许 CONFIG 的管理账号 | redis.js:897 |
| redis.err.cfgFail | 服务端配置读取失败： | redis.js:908 |
| redis.status.cfgLoading | 正在读取服务端配置… | redis.js:911 |
| redis.cfg.maxPlaceholder | 例如 256mb 或 268435456；0 = 不限制 | redis.js:923 |
| redis.cfg.maxLabel | 最大内存 maxmemory | redis.js:924 |
| redis.cfg.maxHelp | 写入后立即生效（CONFIG SET maxmemory） | redis.js:924 |
| redis.cfg.policyLabel | 淘汰策略 maxmemory-policy | redis.js:930 |
| redis.cfg.policyHelp | 内存达到上限时按该策略淘汰键 | redis.js:930 |
| redis.cfg.timeoutPlaceholder | 空闲连接超时秒数；0 = 不断开 | redis.js:933 |
| redis.cfg.timeoutLabel | 空闲超时 timeout | redis.js:934 |
| redis.cfg.timeoutHelp | 客户端空闲多少秒后断开；0 = 不断开 | redis.js:934 |
| redis.btn.saving | 保存中… | redis.js:936 |
| redis.btn.saveCfg | 保存配置 | redis.js:936 |
| redis.cfg.note1 | 只热改三个白名单参数；其它参数请改 redis.conf 并重启。maxmemory 需带单位或字节数， | redis.js:941 |
| redis.cfg.note2 | 策略见下拉，timeout 为秒。 | redis.js:942 |
| redis.err.maxFormat | maxmemory 格式不对：只允许字节整数或 kb/mb/gb 后缀（0 表示不限制） | redis.js:950 |
| redis.err.timeoutFormat | timeout 必须是 0 或正整数秒 | redis.js:956 |
| redis.cfg.saved | 已保存： | redis.js:965 |
| redis.cfg.noChange | 无变化 | redis.js:965 |
| redis.cfg.verified | （已回读生效值） | redis.js:965 |
| redis.err.saveFail | 保存失败： | redis.js:971 |
| redis.auto.connFail | 保存成功，但连接失败： | redis.js:1005 |
| redis.auto.noConn | 保存成功，但没有可用的连接；请检查设置后重试。 | redis.js:1008 |
| redis.confirm.delTitle1 | 将删除以下  | redis.js:1057 |
| redis.confirm.delTitle2 |  个键，操作不可恢复： | redis.js:1057 |
| redis.btn.confirmDel | 确认删除 | redis.js:1061 |
| redis.btn.cancel | 取消 | redis.js:1061 |
| redis.delete.done | 已删除  | redis.js:1071 |
| redis.err.delFail | 删除失败： | redis.js:1077 |
| redis.title.conn | Redis 连接 | redis.js:1099 |
| redis.cfg.autoNote | 已从本机检测结果自动填入主机、端口（标“已自动填入”），只需填写密码。 | redis.js:1103 |
| redis.err.cfgUnavailable | 配置面板不可用，请刷新页面重试 | redis.js:1111 |
| redis.subtitle | 连接一个已有的 Redis 服务：查看连接与内存、浏览键、读取值、批量删除。 | redis.js:1121 |
| redis.btn.settings | 设置 | redis.js:1125 |
| redis.panel.info | 连接信息 | redis.js:1127 |
| redis.panel.infoMeta | 内存 / 连接 / 命中率 / keyspace | redis.js:1127 |
| redis.panel.keys | 键浏览 | redis.js:1131 |
| redis.aria.pattern | 键匹配模式 | redis.js:1139 |
| redis.label.pattern | 匹配模式 | redis.js:1139 |
| redis.aria.limit | 最多返回键数 | redis.js:1141 |
| redis.label.limit | 上限 | redis.js:1142 |
| redis.btn.query | 查询 | redis.js:1143 |
| redis.err.limitRange | 上限必须是 1–10000 的整数 | redis.js:1146 |
| redis.panel.slow | 慢查询 | redis.js:1157 |
| redis.panel.write | 写入键 | redis.js:1161 |
| redis.panel.writeMeta | SET / HSET / RPUSH / SADD / ZADD | redis.js:1161 |
| redis.panel.cfg | 服务端配置 | redis.js:1166 |
| redis.panel.cfgMeta | maxmemory / maxmemory-policy / timeout | redis.js:1166 |
| runtimes.src.known | 常用路径 | runtimes.js:8 |
| runtimes.check.node | Node 安装 | runtimes.js:9 |
| runtimes.check.npm | npm 可用性 | runtimes.js:9 |
| runtimes.check.globalWritable | 全局包目录可写 | runtimes.js:9 |
| runtimes.check.nodeEnv | NODE_ENV 环境变量 | runtimes.js:10 |
| runtimes.check.php | PHP 安装 | runtimes.js:10 |
| runtimes.check.versionSupport | 版本支持 | runtimes.js:10 |
| runtimes.check.extensions | 扩展列表 | runtimes.js:10 |
| runtimes.check.memoryLimit | 内存上限 | runtimes.js:11 |
| runtimes.check.iniLoaded | php.ini 加载 | runtimes.js:11 |
| runtimes.check.python | Python 安装 | runtimes.js:11 |
| runtimes.check.pip | pip 可用性 | runtimes.js:11 |
| runtimes.check.venv | venv 支持 | runtimes.js:12 |
| runtimes.check.siteWritable | site-packages 可写 | runtimes.js:12 |
| runtimes.err.noCsrf | 缺少 CSRF 令牌，请刷新页面或重新登录 | runtimes.js:51 |
| runtimes.err.http | 请求失败（HTTP  | runtimes.js:62 |
| runtimes.err.timeoutPrefix | 请求超时（ | runtimes.js:66 |
| runtimes.err.timeoutSuffix |  秒） | runtimes.js:66 |
| runtimes.cmd.debian | Debian / Ubuntu | runtimes.js:73 |
| runtimes.cmd.nvmInstalled | 已安装 nvm 时 | runtimes.js:73 |
| runtimes.cmd.official | 官方安装包 | runtimes.js:73 |
| runtimes.cmd.phpenvInstalled | 已安装 phpenv 时 | runtimes.js:75 |
| runtimes.cmd.pyenvInstalled | 已安装 pyenv 时 | runtimes.js:77 |
| runtimes.detail.npmVersion | npm 版本 | runtimes.js:80 |
| runtimes.detail.v8 | V8 引擎 | runtimes.js:80 |
| runtimes.detail.openssl | OpenSSL | runtimes.js:81 |
| runtimes.detail.globalPkgs | 全局包 | runtimes.js:81 |
| runtimes.unit.count |  个 | runtimes.js:81 |
| runtimes.detail.iniPath | 配置文件 | runtimes.js:84 |
| runtimes.detail.iniNone | 未加载 php.ini | runtimes.js:84 |
| runtimes.detail.extensions | 扩展 | runtimes.js:84 |
| runtimes.unit.countColon |  个： | runtimes.js:84 |
| runtimes.detail.noLimit | 0（不限制） | runtimes.js:86 |
| runtimes.detail.pipVersion | pip 版本 | runtimes.js:88 |
| runtimes.detail.sitePackages | site-packages | runtimes.js:88 |
| runtimes.detail.installedPkgs | 已安装包 | runtimes.js:89 |
| runtimes.detail.venvOK | venv 可用 | runtimes.js:89 |
| runtimes.yes | 是 | runtimes.js:89 |
| runtimes.no | 否 | runtimes.js:89 |
| runtimes.has | 有 | runtimes.js:102 |
| runtimes.none | 无 | runtimes.js:102 |
| runtimes.status.detecting | 正在探测  | runtimes.js:154 |
| runtimes.ellipsis | … | runtimes.js:154 |
| runtimes.unit.countSpaced |  个  | runtimes.js:155 |
| runtimes.status.defaultSuffix | ，默认  | runtimes.js:155 |
| runtimes.status.notDetected | 未检测到  | runtimes.js:155 |
| runtimes.badge.installed | 已安装 | runtimes.js:156 |
| runtimes.badge.notInstalled | 未安装 | runtimes.js:156 |
| runtimes.empty.hint | 安装后点「重新探测」即可看到版本。 | runtimes.js:162 |
| runtimes.status.reading | 正在读取  | runtimes.js:175 |
| runtimes.status.readingSuffix |  的详情… | runtimes.js:175 |
| runtimes.detail.expandHint | 展开后读取详情… | runtimes.js:175 |
| runtimes.col.version | 版本 | runtimes.js:183 |
| runtimes.col.path | 路径 | runtimes.js:183 |
| runtimes.col.source | 来源 | runtimes.js:183 |
| runtimes.col.default | 默认 | runtimes.js:183 |
| runtimes.panel.versions | 版本列表 | runtimes.js:206 |
| runtimes.panel.versionsMeta | 点击版本行展开该版本的详情 | runtimes.js:207 |
| runtimes.err.versionFail | 版本探测失败： | runtimes.js:208 |
| runtimes.panel.projects | 项目扫描 | runtimes.js:230 |
| runtimes.panel.projectsMeta | 深度 ≤3 · 条目 ≤200 · 只读清单 | runtimes.js:231 |
| runtimes.label.root | 根目录 | runtimes.js:233 |
| runtimes.btn.scanning | 扫描中… | runtimes.js:240 |
| runtimes.btn.scan | 扫描 | runtimes.js:240 |
| runtimes.err.rootEmpty | 请先填写根目录（预设 /var/www、/opt、/home） | runtimes.js:244 |
| runtimes.projects.hint | 输入根目录后点「扫描」；只读项目清单，不执行项目脚本。 | runtimes.js:253 |
| runtimes.projects.foundPrefix | 在  | runtimes.js:255 |
| runtimes.projects.noneMid |  下没有发现  | runtimes.js:255 |
| runtimes.projects.noneSuffix |  项目；可换 /opt 或 /home 再试，项目需在 3 层目录内。 | runtimes.js:255 |
| runtimes.projects.found | 共找到  | runtimes.js:258 |
| runtimes.projects.skipped | 已跳过  | runtimes.js:260 |
| runtimes.projects.skippedSuffix |  个条目： | runtimes.js:260 |
| runtimes.panel.doctor | 健康检查 | runtimes.js:265 |
| runtimes.status.checking | 正在体检… | runtimes.js:266 |
| runtimes.doctor.failCount |  项失败 | runtimes.js:269 |
| runtimes.doctor.warnCount |  项警告 | runtimes.js:269 |
| runtimes.doctor.allPass | 全部通过 | runtimes.js:269 |
| runtimes.err.doctorFail | 健康检查失败： | runtimes.js:271 |
| runtimes.doctor.empty | 没有返回检查项。 | runtimes.js:273 |
| runtimes.doctor.fail | 失败 | runtimes.js:278 |
| runtimes.doctor.warn | 警告 | runtimes.js:278 |
| runtimes.doctor.pass | 通过 | runtimes.js:278 |
| runtimes.doctor.fixLabel | 修复命令： | runtimes.js:285 |
| runtimes.title | 运行环境 | runtimes.js:316 |
| runtimes.subtitle | Node.js / PHP / Python 的版本、单版本详情、项目依赖与健康检查；只读探测，不修改宿主文件。 | runtimes.js:317 |
| runtimes.btn.redetect | 重新探测 | runtimes.js:318 |
| runtimes.aria.tablist | 运行时切换 | runtimes.js:327 |
| sshguard.window.24h | 最近 24 小时 | sshguard.js:13 |
| sshguard.window.7d | 最近 7 天 | sshguard.js:13 |
| sshguard.err.noCsrf | 缺少 CSRF 令牌，请刷新页面或重新登录 | sshguard.js:57 |
| sshguard.err.http | 请求失败（HTTP  | sshguard.js:69 |
| sshguard.err.timeout | 请求超时（15 秒） | sshguard.js:74 |
| sshguard.engine.none | 未检测到防护源 | sshguard.js:82 |
| sshguard.cell.fail2ban | fail2ban | sshguard.js:83 |
| sshguard.sep.dot |  ·  | sshguard.js:83 |
| sshguard.engine.sshdOnly | 仅 sshd 日志（无自动封禁） | sshguard.js:84 |
| sshguard.remain.expired | 已到期 | sshguard.js:98 |
| sshguard.remain.days |  天  | sshguard.js:99 |
| sshguard.remain.hours |  小时 | sshguard.js:99 |
| sshguard.remain.minutes |  分钟 | sshguard.js:100 |
| sshguard.word.fail | 失败 | sshguard.js:113 |
| sshguard.word.failColon | 失败： | sshguard.js:116 |
| sshguard.word.reasonUnknown | 原因未知 | sshguard.js:116 |
| sshguard.err.operationFail | 操作失败 | sshguard.js:122 |
| sshguard.label.reason | 原因： | sshguard.js:125 |
| sshguard.btn.viewRaw | 查看原始错误 | sshguard.js:130 |
| sshguard.btn.runbook | 查看运行手册 | sshguard.js:134 |
| sshguard.btn.viewBackendHint | 查看后端原始提示 | sshguard.js:165 |
| sshguard.cfg.title | SSH 防护设置 | sshguard.js:176 |
| sshguard.err.cfgUnavailable | 配置面板未加载，请刷新页面后重试 | sshguard.js:178 |
| sshguard.sep.colon | ： | sshguard.js:190 |
| sshguard.btn.goStore | 去软件商店安装 | sshguard.js:191 |
| sshguard.cmd.restartKore | sudo systemctl restart kore | sshguard.js:194 |
| sshguard.status.loading | 正在读取 SSH 防护状态… | sshguard.js:199 |
| sshguard.readonly.why | 当前没有可用的自动封禁能力（fail2ban 未装或未运行），封禁/解封按钮已禁用。 | sshguard.js:203 |
| sshguard.badge.autoBan | 自动封禁已启用 | sshguard.js:205 |
| sshguard.badge.readonly | 只读模式 | sshguard.js:205 |
| sshguard.label.source | 防护源： | sshguard.js:206 |
| sshguard.cell.engine | 防护引擎 | sshguard.js:209 |
| sshguard.fail2ban.running | 已安装 · 运行中 | sshguard.js:210 |
| sshguard.fail2ban.stopped | 已安装 · 未运行 | sshguard.js:210 |
| sshguard.fail2ban.notInstalled | 未安装 | sshguard.js:210 |
| sshguard.cell.logSource | 日志来源 | sshguard.js:211 |
| sshguard.logSource.denied | 读不到（权限不足） | sshguard.js:211 |
| sshguard.cell.banned | 当前封禁 | sshguard.js:212 |
| sshguard.cell.failed24h | 24 小时失败 | sshguard.js:213 |
| sshguard.unit.times |  次 | sshguard.js:213 |
| sshguard.cell.window | 扫描窗口 | sshguard.js:214 |
| sshguard.guide.readonlyTitle | 只读模式：能看统计，不能封禁 | sshguard.js:221 |
| sshguard.guide.missingPrefix | 当前缺的是「 | sshguard.js:223 |
| sshguard.guide.notInstalled | fail2ban 未安装 | sshguard.js:223 |
| sshguard.guide.notRunning | fail2ban 未运行 | sshguard.js:223 |
| sshguard.guide.noPriv | 提权通道不可用 | sshguard.js:223 |
| sshguard.guide.missingSuffix | 」。 | sshguard.js:223 |
| sshguard.cmd.enableFail2ban | sudo systemctl enable --now fail2ban | sshguard.js:224 |
| sshguard.cmd.aptFail2ban | sudo apt install fail2ban      # Debian / Ubuntu | sshguard.js:224 |
| sshguard.cmd.dnfFail2ban | sudo dnf install fail2ban      # RHEL / Fedora | sshguard.js:224 |
| sshguard.status.counting | 正在统计登录失败记录… | sshguard.js:240 |
| sshguard.attempts.involve | 涉及  | sshguard.js:246 |
| sshguard.attempts.invalidUser |  个来源 IP · 无效用户  | sshguard.js:246 |
| sshguard.attempts.successLogin |  次 · 成功登录  | sshguard.js:247 |
| sshguard.attempts.logSource |  次 · 日志来源  | sshguard.js:247 |
| sshguard.attempts.noTime |  条无时间戳 | sshguard.js:248 |
| sshguard.verdict.none | 这个窗口内没有登录失败记录：看起来没人在试密码。 | sshguard.js:251 |
| sshguard.verdict.targeted | 失败高度集中在 {n} 个 IP（最高 {ip} 占 {pct}%）：像定向暴力破解，建议直接封这两个地址。 | sshguard.js:256 |
| sshguard.verdict.distributed | 失败来自 {n} 个以上不同 IP、单 IP 占比不高：像分布式扫描/撞库，建议按 Top IP 逐个封禁并确认密码策略。 | sshguard.js:258 |
| sshguard.verdict.spread | 失败分散在 {n} 个 IP：{note} | sshguard.js:259 |
| sshguard.verdict.heavy | 量偏大，建议封 Top IP。 | sshguard.js:259 |
| sshguard.verdict.light | 量不大，先观察。 | sshguard.js:259 |
| sshguard.attempts.noSource | 没有可聚合的失败来源。日志读不到时请检查插件设置里的日志路径，或改用 journal 来源。 | sshguard.js:266 |
| sshguard.col.sourceIp | 来源 IP | sshguard.js:276 |
| sshguard.col.failCount | 失败次数 | sshguard.js:277 |
| sshguard.col.ratio | 占比 | sshguard.js:279 |
| sshguard.col.actions | 操作 | sshguard.js:283 |
| sshguard.btn.banIp | 封禁此 IP | sshguard.js:284 |
| sshguard.chart.label | 每小时失败次数（最高  | sshguard.js:297 |
| sshguard.chart.aria | 按小时统计的登录失败次数：悬停或点按柱子读出每格数值 | sshguard.js:323 |
| sshguard.source.fail2ban | fail2ban 封禁 | sshguard.js:346 |
| sshguard.source.inferredPrefix | 日志推断（ | sshguard.js:347 |
| sshguard.source.unknown | 未知 | sshguard.js:348 |
| sshguard.status.loadingBans | 正在读取封禁名单… | sshguard.js:361 |
| sshguard.bans.emptyReadonly | 没有封禁记录。自动封禁未启用时，这里不会出现新条目。 | sshguard.js:364 |
| sshguard.bans.emptyOk | 当前没有封禁任何 IP。上面「手动封禁」填一个地址即可。 | sshguard.js:365 |
| sshguard.guide.inferredTitle | 下面是「可疑 IP」而不是封禁名单 | sshguard.js:369 |
| sshguard.guide.inferredLine1 | 当前没有运行中的 fail2ban，插件只能从登录日志里按阈值挑出可疑来源；这些 IP 并没有被真正封禁。 | sshguard.js:370 |
| sshguard.guide.inferredLine2 | 要真正封禁，请先启动 fail2ban，再用上面的「封禁此 IP」。 | sshguard.js:371 |
| sshguard.label.ip | IP 地址 | sshguard.js:379 |
| sshguard.col.ip | IP 地址 | sshguard.js:383 |
| sshguard.col.source | 来源 | sshguard.js:384 |
| sshguard.col.reason | 原因 | sshguard.js:385 |
| sshguard.bans.confirmUnban | 确定解封？ | sshguard.js:388 |
| sshguard.btn.confirm | 确认 | sshguard.js:389 |
| sshguard.btn.cancel | 取消 | sshguard.js:390 |
| sshguard.btn.unban | 解封 | sshguard.js:394 |
| sshguard.bans.inferredTitle | 这是从日志推断的可疑 IP，并没有真的被封禁；需要封禁请用上面的「封禁此 IP」 | sshguard.js:397 |
| sshguard.ban.hintNeed |  需要：fail2ban 在运行 + kored 以 root 启动（提权通道）。 | sshguard.js:410 |
| sshguard.ban.hintFlow | 封禁走内核提权通道执行 fail2ban-client；不可回滚，页面会先申请一次性确认令牌再提交。 | sshguard.js:411 |
| sshguard.err.ipEmpty | 请填一个 IP 地址（例如 203.0.113.7） | sshguard.js:416 |
| sshguard.err.ipFormat | IP 格式不对：只接受纯 IPv4 / IPv6 地址（不支持网段） | sshguard.js:418 |
| sshguard.status.token | 正在申请一次性确认令牌… | sshguard.js:420 |
| sshguard.err.noToken | 内核没有返回确认令牌 | sshguard.js:423 |
| sshguard.status.banning | 正在封禁  | sshguard.js:424 |
| sshguard.ban.verified | （已回读封禁清单确认生效） | sshguard.js:430 |
| sshguard.ban.unverifiedPrefix | （已执行，但回读未确认： | sshguard.js:430 |
| sshguard.ban.refreshNote | 请手动刷新名单核对 | sshguard.js:430 |
| sshguard.ban.noResult | 没有确认到封禁结果 | sshguard.js:434 |
| sshguard.word.ban | 封禁 | sshguard.js:439 |
| sshguard.status.unbanning | 正在解封  | sshguard.js:446 |
| sshguard.unban.done | 已解封  | sshguard.js:450 |
| sshguard.unban.verified | （已回读确认） | sshguard.js:450 |
| sshguard.copy.done | 已复制 | sshguard.js:468 |
| sshguard.copy.fail | 复制失败：请手动选中文本复制 | sshguard.js:469 |
| sshguard.err.portRange | 端口必须是 1–65535 的整数（留空表示保持当前端口） | sshguard.js:504 |
| sshguard.err.maxRange | 最大认证次数必须是 1–100 的整数 | sshguard.js:509 |
| sshguard.status.suggesting | 正在生成建议… | sshguard.js:512 |
| sshguard.word.genSuggest | 生成加固建议 | sshguard.js:521 |
| sshguard.sug.genFail | 生成失败 | sshguard.js:530 |
| sshguard.sug.failNote | 这是后端返回的原因，不是登录失效。 | sshguard.js:530 |
| sshguard.sug.hint | 勾选要加固的项后点「生成建议」：会给出建议配置、与当前值的差异、风险与回滚，以及可整段复制的落地命令。 | sshguard.js:534 |
| sshguard.sug.note | 建议态：kore 不会自动下发，请确认后手动执行。页面不提供「一键应用」。 | sshguard.js:538 |
| sshguard.sug.configTitle | 建议配置（/etc/ssh/sshd_config.d/kore.conf） | sshguard.js:541 |
| sshguard.btn.copyConfig | 复制配置 | sshguard.js:545 |
| sshguard.sug.diffTitle | 与当前值对比 | sshguard.js:550 |
| sshguard.sug.noDiff | 当前没有可对比的差异（可能未改动任何项）。 | sshguard.js:560 |
| sshguard.sug.riskTitle | 风险提示（每条都带怎么回滚） | sshguard.js:566 |
| sshguard.risk.high | 高危 | sshguard.js:572 |
| sshguard.risk.medium | 注意 | sshguard.js:572 |
| sshguard.risk.low | 提示 | sshguard.js:572 |
| sshguard.sug.rollback | 回滚： | sshguard.js:575 |
| sshguard.sug.rollbackDefault | 按 apply_commands 里的备份恢复，再 sshd -t && systemctl reload sshd | sshguard.js:575 |
| sshguard.sug.applyTitle | 落地命令（整段复制，确认后手动执行） | sshguard.js:581 |
| sshguard.sug.noCmd | （后端没有返回命令） | sshguard.js:582 |
| sshguard.btn.copyAll | 复制全部命令 | sshguard.js:585 |
| sshguard.sug.verifyTitle | 验证命令（sshd -T 看最终生效值） | sshguard.js:589 |
| sshguard.btn.copyVerify | 复制验证命令 | sshguard.js:593 |
| sshguard.word.stat | 统计 | sshguard.js:613 |
| sshguard.title | SSH 防护 | sshguard.js:720 |
| sshguard.subtitle | 看看谁在试密码、封掉它，并管理当前的封禁名单。 | sshguard.js:721 |
| sshguard.panel.status | 防护状态 | sshguard.js:724 |
| sshguard.panel.statusMeta | 只读探测，不修改 sshd 配置 | sshguard.js:724 |
| sshguard.btn.cfg | 防护设置 | sshguard.js:727 |
| sshguard.btn.refresh | 刷新 | sshguard.js:728 |
| sshguard.panel.attempts | 暴力破解统计 | sshguard.js:732 |
| sshguard.panel.bans | 封禁名单 | sshguard.js:743 |
| sshguard.panel.manualBan | 手动封禁 | sshguard.js:748 |
| sshguard.panel.banMeta | 封禁持续到你手动解封 | sshguard.js:748 |
| sshguard.label.banDuration | 封禁时长 | sshguard.js:757 |
| sshguard.ban.duration | 持续到你手动解封 | sshguard.js:758 |
| sshguard.ban.note | fail2ban 的 ban.add 没有时长参数：封禁会一直生效，直到你在上面的名单里手动解封。需要自动到期请改 fail2ban 的 bantime。 | sshguard.js:760 |
| sshguard.btn.banThisIp | 封禁这个 IP | sshguard.js:762 |
| sshguard.panel.suggest | 加固建议 | sshguard.js:769 |
| sshguard.panel.suggestMeta | 只生成建议，不自动下发 | sshguard.js:769 |
| sshguard.sug.disablePw | 关闭密码认证（仅保留密钥等） | sshguard.js:778 |
| sshguard.sug.disableRoot | 禁止 root 直接登录 | sshguard.js:779 |
| sshguard.label.port | SSH 端口（留空 = 保持当前） | sshguard.js:781 |
| sshguard.sug.portPlaceholder | 例如 2222 | sshguard.js:783 |
| sshguard.label.maxAuth | 最大认证次数 | sshguard.js:785 |
| sshguard.btn.genSuggest | 生成建议 | sshguard.js:789 |
| sshguard.sug.footer | 只读生成：建议配置 + 差异 + 风险（含回滚）+ 可复制命令；不会修改 /etc/ssh，也没有「一键应用」。 | sshguard.js:792 |
| search.err.noCsrf | 缺少安全令牌，请刷新页面或重新登录 | search.js:129 |
| search.err.http | 请求失败（HTTP  | search.js:138 |
| search.err.pluginsFail | 插件列表读取失败 | search.js:154 |
| search.err.storeFail | 商店数据读取失败 | search.js:156 |
| search.err.sitesFail | 站点列表没读到（站点插件可能还没装或没启用）：请到「软件商店」确认 site 插件已安装并启用，再重新搜索。 | search.js:158 |
| search.err.fileFailPrefix | 文件搜索没成功（ | search.js:177 |
| search.err.unknown | 未知原因 | search.js:177 |
| search.err.fileFailSuffix | ）：请到「软件商店」确认「文件管理」插件已安装并启用，或换个关键词再试。 | search.js:178 |
| search.label.site | 站点 ·  | search.js:225 |
| search.site.enabled | 已启用 | search.js:226 |
| search.site.disabled | 已停用 | search.js:226 |
| search.kind.dir | 目录 | search.js:233 |
| search.kind.file | 文件 | search.js:233 |
| search.label.file | 文件 · / | search.js:234 |
| search.label.goto | 跳转到  | search.js:238 |
| search.label.page | 页面 ·  | search.js:238 |
| search.label.openPlugin | 打开插件详情 ·  | search.js:244 |
| search.label.installed | 已装插件 ·  | search.js:244 |
| search.label.installFromStore | 去商店安装 ·  | search.js:250 |
| search.label.storePlugin | 商店插件 ·  | search.js:250 |
| search.label.execute | 执行： | search.js:255 |
| search.label.action | 操作 ·  | search.js:255 |
| search.group.sites | 站点 | search.js:259 |
| search.group.files | 文件 | search.js:259 |
| search.group.pages | 页面 | search.js:260 |
| search.group.plugins | 插件 | search.js:260 |
| search.group.store | 商店 | search.js:261 |
| search.group.acts | 操作 | search.js:261 |
| search.note.hint | 输入关键词：站点域名、文件名、页面名、插件 id/名称、动作（如 数据库 / 备份 / 新建） | search.js:278 |
| search.empty.prefix | 没找到「 | search.js:294 |
| search.empty.suffix | 」，试试：数据库 / 站点 / 备份 | search.js:294 |
| search.note.searchingPrefix | 正在按文件名搜索「 | search.js:299 |
| search.note.searchingSuffix | 」… | search.js:299 |
| search.note.sitesLoading | 站点列表加载中… | search.js:305 |
| search.note.pluginsLoading | 插件与商店数据加载中… | search.js:310 |
| search.note.partialOk | （页面与操作仍可搜索） | search.js:312 |
| search.aria.title | 全局搜索 | search.js:342 |
| search.aria.placeholder | 搜索站点、文件、页面、插件与操作… | search.js:351 |
| search.aria.keyword | 全局搜索关键词 | search.js:352 |
| search.foot.keys | ↑↓ 选择 · Enter 执行 · Esc 关闭 | search.js:358 |

共 508 个去重 key；源自四视图 tr(key, 中文fallback) 逐字提取，未含 params 占位符行内插值。
