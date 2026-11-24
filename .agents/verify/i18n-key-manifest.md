# i18n 本地化 key 清单（三视图卡汇总）
> 用途：语言包收口卡据此写 web/i18n/en-US.js；zh-CN.js 不写这些键（首屏余量 150 字节）
> 来源：r8-i18nui(956ce99) sites 30 / r8-i18n-db(ee1d606) db 92 / r8-i18n-files(64ae7d8) files 152
> 合计 274 条；占位符 {name}/{n}/{size}/{note} 原样保留
> key + 中文取视图源码 `tr(key, '中文')` 的提取值（唯一真源），行号为源码首次出现行；反引号包裹中文以保真（前导空格/转义符/占位符）
> 英文列：19 条高频映射照抄三张卡建议，其余标注待收口卡按语义翻译

## sites.*（30 条）

| key | 中文 | 英文 | 行 |
| --- | --- | --- | --- |
| sites.action.delete | `删除` | （待收口卡按语义翻译） | 794 |
| sites.action.disable | `停用` | （待收口卡按语义翻译） | 771 |
| sites.action.enable | `启用` | （待收口卡按语义翻译） | 771 |
| sites.action.manage | `管理` | Manage | 767 |
| sites.action.status | `状态` | （待收口卡按语义翻译） | 776 |
| sites.col.actions | `操作` | Actions | 743 |
| sites.col.domain | `域名` | Domain | 743 |
| sites.col.status | `生效状态` | Status | 743 |
| sites.config.button | `连接配置` | （待收口卡按语义翻译） | 815 |
| sites.config.collapse | `收起连接配置` | （待收口卡按语义翻译） | 820 |
| sites.delete.cancel | `取消` | （待收口卡按语义翻译） | 148 |
| sites.delete.confirm | `确认删除` | （待收口卡按语义翻译） | 149 |
| sites.delete.title | `删除确认` | （待收口卡按语义翻译） | 144 |
| sites.detail.collapse | `收起` | （待收口卡按语义翻译） | 684 |
| sites.detail.running | `运行中` | （待收口卡按语义翻译） | 683 |
| sites.detail.stopped | `已停用` | （待收口卡按语义翻译） | 683 |
| sites.detail.title | `站点详情` | （待收口卡按语义翻译） | 682 |
| sites.empty.cta | `创建第一个站点` | （待收口卡按语义翻译） | 733 |
| sites.empty.hint | `还没有站点：用上面的建站向导创建第一个站点，向导会自动填好根目录。` | （待收口卡按语义翻译） | 732 |
| sites.list.title | `站点列表` | Sites | 830 |
| sites.load.failed | `站点列表读取失败：` | （待收口卡按语义翻译） | 805 |
| sites.load.loading | `正在读取站点列表…` | （待收口卡按语义翻译） | 800 |
| sites.load.none | `还没有站点，用上方向导创建第一个站点` | （待收口卡按语义翻译） | 804 |
| sites.load.ok | `站点列表已刷新` | （待收口卡按语义翻译） | 804 |
| sites.refresh | `刷新` | Refresh | 832 |
| sites.status.meta | `配置 / 校验 / 目录 / 加载` | （待收口卡按语义翻译） | 714 |
| sites.status.recheck | `重新检查` | （待收口卡按语义翻译） | 715 |
| sites.status.title | `运行状态` | （待收口卡按语义翻译） | 713 |
| sites.subtitle | `向导一次收齐域名、根目录、SSL 与伪静态；点域名查看完整配置并继续管理。` | （待收口卡按语义翻译） | 810 |
| sites.title | `网站管理` | Websites | 809 |

## db.*（92 条）

| key | 中文 | 英文 | 行 |
| --- | --- | --- | --- |
| db.action.analyze | `分析` | （待收口卡按语义翻译） | 685 |
| db.action.configConn | `配置连接` | （待收口卡按语义翻译） | 329 |
| db.action.createDb | `新建数据库` | （待收口卡按语义翻译） | 780 |
| db.action.drop | `删除` | （待收口卡按语义翻译） | 550 |
| db.action.editConn | `修改连接` | （待收口卡按语义翻译） | 356 |
| db.action.export | `导出` | （待收口卡按语义翻译） | 544 |
| db.action.import | `导入` | （待收口卡按语义翻译） | 783 |
| db.action.manualConfig | `手动配置` | （待收口卡按语义翻译） | 373 |
| db.action.oneClickConn | `一键连接` | （待收口卡按语义翻译） | 417 |
| db.action.redetect | `重新检测` | （待收口卡按语义翻译） | 357 |
| db.action.retry | `重新读取` | （待收口卡按语义翻译） | 330 |
| db.action.run | `执行` | （待收口卡按语义翻译） | 822 |
| db.action.settings | `设置` | （待收口卡按语义翻译） | 1038 |
| db.banner.detectFailed | `未能完成自动检测` | （待收口卡按语义翻译） | 370 |
| db.banner.detectUnavailable | `自动检测不可用` | （待收口卡按语义翻译） | 369 |
| db.banner.detecting | `正在检测本机 MySQL/MariaDB…` | （待收口卡按语义翻译） | 363 |
| db.banner.notDetected | `未检测到本机 MySQL/MariaDB` | （待收口卡按语义翻译） | 380 |
| db.banner.pgConnected | `已连接 PostgreSQL ` | （待收口卡按语义翻译） | 326 |
| db.banner.pgNotConfigured | `PostgreSQL 数据库连接未配置或不可达` | （待收口卡按语义翻译） | 335 |
| db.db.emptyFiltered | `没有可展示的数据库（系统库已过滤）` | （待收口卡按语义翻译） | 535 |
| db.db.error | `库列表读取失败：` | （待收口卡按语义翻译） | 533 |
| db.db.loading | `正在读取数据库…` | （待收口卡按语义翻译） | 534 |
| db.db.showTables | `SHOW TABLES` | （待收口卡按语义翻译） | 541 |
| db.detail.title | `数据库连接详情` | （待收口卡按语义翻译） | 768 |
| db.empty.envFaq | `已有环境变量配置？` | （待收口卡按语义翻译） | 486 |
| db.empty.loadError | `读取连接失败` | （待收口卡按语义翻译） | 440 |
| db.empty.noConnections | `还没有数据库连接` | （待收口卡按语义翻译） | 462 |
| db.empty.noPgConnections | `还没有 PostgreSQL 连接` | （待收口卡按语义翻译） | 451 |
| db.error.connectFailed | `连接失败：` | （待收口卡按语义翻译） | 505 |
| db.error.l2Load | `L2 管理模块加载失败：` | （待收口卡按语义翻译） | 168 |
| db.error.refreshRetry | `。刷新页面后重试。` | （待收口卡按语义翻译） | 168 |
| db.hint.accessDenied | `请确认用户名和密码。密码忘记可在服务器上重置：ALTER USER \'root\'@\'localhost\' IDENTIFIED BY \'<新密码>\'；` | 待收口卡按语义翻译；`<新密码>`→`<new password>` | 294 |
| db.hint.badHost | `主机名无法解析：本机数据库请填 127.0.0.1，远程数据库请填可解析的 IP 或域名。` | （待收口卡按语义翻译） | 301 |
| db.hint.generic | `检查地址、端口、用户名和密码；确认数据库已启动并允许该账号从本机登录，然后重试。` | （待收口卡按语义翻译） | 306 |
| db.hint.noListener | `服务没有在目标端口监听：确认数据库已启动（systemctl status mariadb 或 mysqld），或把端口改成实际监听端口。` | （待收口卡按语义翻译） | 298 |
| db.hint.passwordEnv | `密码环境变量未设置：直接在设置里填写“密码”，或启动内核前导出该环境变量。` | （待收口卡按语义翻译） | 304 |
| db.hint.pgConfig | `连接配置不完整或非法：点「配置连接」补齐 host/port/用户名与密码后再试。` | Connection settings are incomplete or invalid: click Configure connection to fill in host/port, username and password, then retry. | 111 |
| db.hint.pgGeneric | `检查插件设置里的 host/port/用户名与密码，确认服务已启动并允许该账号从本机登录。` | （待收口卡按语义翻译） | 115 |
| db.hint.pgMissingPlugin | `PostgreSQL 插件（db-postgres）未安装或未启用：到「插件」页安装并启用后刷新本页。` | （待收口卡按语义翻译） | 110 |
| db.hint.pgUnreachable | `检查 PostgreSQL 是否已启动、端口是否监听、host 是否可达；容器部署请填宿主机的发布端口（如 15432）。` | （待收口卡按语义翻译） | 113 |
| db.label.connectionType | `连接类型` | （待收口卡按语义翻译） | 1043 |
| db.label.default | `默认连接` | （待收口卡按语义翻译） | 499 |
| db.panel.databases | `数据库` | （待收口卡按语义翻译） | 775 |
| db.panel.users | `用户与授权` | （待收口卡按语义翻译） | 852 |
| db.panel.usersMeta | `创建账号 · 授权 · 删除` | （待收口卡按语义翻译） | 853 |
| db.prefix.howto | `怎么办：` | （待收口卡按语义翻译） | 442 |
| db.query.emptyInput | `请输入 SQL 后再执行` | （待收口卡按语义翻译） | 891 |
| db.query.running | `执行中…` | Running… | 562 |
| db.result.hint | `执行 SQL 后在此查看结果` | （待收口卡按语义翻译） | 569 |
| db.result.noColumns | `查询未返回列` | （待收口卡按语义翻译） | 576 |
| db.result.noRows | `查询未返回结果` | The query returned no rows | 569 |
| db.result.truncated | `已截断，仅显示前 {n} 行` | （待收口卡按语义翻译） | 575 |
| db.result.zeroRows | `（0 行）` | （待收口卡按语义翻译） | 583 |
| db.settings.unavailable | `配置面板不可用，请刷新页面重试` | （待收口卡按语义翻译） | 1012 |
| db.slow.allSchemas | `全部库` | （待收口卡按语义翻译） | 659 |
| db.slow.col.avg | `平均` | （待收口卡按语义翻译） | 718 |
| db.slow.col.executions | `执行次数` | （待收口卡按语义翻译） | 718 |
| db.slow.col.max | `最大` | （待收口卡按语义翻译） | 718 |
| db.slow.col.rowsExamined | `扫描行数` | （待收口卡按语义翻译） | 718 |
| db.slow.col.summary | `SQL 摘要` | （待收口卡按语义翻译） | 718 |
| db.slow.col.total | `总耗时` | （待收口卡按语义翻译） | 718 |
| db.slow.connection | `数据库连接` | （待收口卡按语义翻译） | 631 |
| db.slow.limit | `条数` | （待收口卡按语义翻译） | 677 |
| db.slow.rawInfo | `原始信息：` | （待收口卡按语义翻译） | 692 |
| db.slow.running | `正在分析慢查询…` | （待收口卡按语义翻译） | 695 |
| db.slow.schema | `库` | （待收口卡按语义翻译） | 656 |
| db.slow.sortedBy | `按总耗时排序` | （待收口卡按语义翻译） | 835 |
| db.slow.threshold | `阈值` | （待收口卡按语义翻译） | 668 |
| db.slow.title | `慢查询分析` | Slow query analysis | 834 |
| db.sql.shortcut | `Ctrl+Enter 执行` | （待收口卡按语义翻译） | 808 |
| db.sql.title | `SQL 控制台` | （待收口卡按语义翻译） | 808 |
| db.stat.blocksHit | `命中块` | （待收口卡按语义翻译） | 519 |
| db.stat.cacheHit | `缓存命中率` | （待收口卡按语义翻译） | 519 |
| db.stat.connections | `连接数` | （待收口卡按语义翻译） | 518 |
| db.stat.databases | `数据库` | （待收口卡按语义翻译） | 518 |
| db.stat.maxConnections | `最大连接` | （待收口卡按语义翻译） | 521 |
| db.stat.queries | `查询总数` | （待收口卡按语义翻译） | 520 |
| db.stat.slowQueries | `慢查询` | （待收口卡按语义翻译） | 521 |
| db.stat.threads | `连接线程` | （待收口卡按语义翻译） | 520 |
| db.stat.uptime | `运行时长` | （待收口卡按语义翻译） | 518 |
| db.stat.version | `版本` | （待收口卡按语义翻译） | 519 |
| db.state.connected | `已连接` | （待收口卡按语义翻译） | 325 |
| db.state.reachable | `可达` | （待收口卡按语义翻译） | 500 |
| db.state.unreachable | `不可达` | （待收口卡按语义翻译） | 500 |
| db.status.error | `状态读取失败：` | （待收口卡按语义翻译） | 514 |
| db.status.loading | `正在读取连接状态…` | （待收口卡按语义翻译） | 515 |
| db.title | `数据库` | Databases | 1031 |
| db.unit.databases | ` 个库` | 待收口卡按语义翻译；拼接用前导空格保留 | 532 |
| db.unit.rows | ` 行` | 待收口卡按语义翻译；拼接用前导空格保留 | 574 |
| db.unit.seconds | ` 秒` | 待收口卡按语义翻译；拼接用前导空格保留 | 526 |
| db.unknown.reason | `原因未知` | （待收口卡按语义翻译） | 505 |
| db.unknown.version | `版本未知` | （待收口卡按语义翻译） | 503 |

## files.*（152 条）

| key | 中文 | 英文 | 行 |
| --- | --- | --- | --- |
| files.action.cancel | `取消` | （待收口卡按语义翻译） | 129 |
| files.action.ok | `确定` | （待收口卡按语义翻译） | 130 |
| files.action.save | `保存` | （待收口卡按语义翻译） | 486 |
| files.batch.delete | `批量删除` | （待收口卡按语义翻译） | 954 |
| files.batch.move | `批量移动` | （待收口卡按语义翻译） | 957 |
| files.batch.moveTo.label | `目标目录（相对根目录，如 docs；不能为空）` | （待收口卡按语义翻译） | 160 |
| files.batch.moveTo.noSel | `请先勾选要移动的条目` | （待收口卡按语义翻译） | 159 |
| files.batch.moveTo.title | `批量移动到` | （待收口卡按语义翻译） | 160 |
| files.col.actions | `操作` | （待收口卡按语义翻译） | 321 |
| files.col.mode | `权限` | （待收口卡按语义翻译） | 321 |
| files.col.modified | `修改时间` | （待收口卡按语义翻译） | 321 |
| files.col.name | `名称` | （待收口卡按语义翻译） | 321 |
| files.col.originalPath | `原路径` | （待收口卡按语义翻译） | 766 |
| files.col.size | `大小` | （待收口卡按语义翻译） | 321 |
| files.compress | `压缩` | （待收口卡按语义翻译） | 950 |
| files.crumbs.aria | `当前路径` | （待收口卡按语义翻译） | 937 |
| files.dirContent | `目录内容` | （待收口卡按语义翻译） | 572 |
| files.edit.binaryNoEdit | `二进制文件不支持编辑` | （待收口卡按语义翻译） | 430 |
| files.edit.conflict | `文件已被其他会话修改，请刷新后重试` | （待收口卡按语义翻译） | 460 |
| files.edit.contentTooLarge | `内容超过单帧上限，请拆分文件` | （待收口卡按语义翻译） | 447 |
| files.edit.exited | `已退出编辑` | （待收口卡按语义翻译） | 489 |
| files.edit.loaded | `已加载 {size}{note}` | Loaded {size}{note} | 438 |
| files.edit.loading | `正在加载编辑器…` | （待收口卡按语义翻译） | 426 |
| files.edit.maxInline | `在线编辑上限 {size}` | （待收口卡按语义翻译） | 497 |
| files.edit.noShaNote | `（浏览器不支持摘要，关闭乐观锁）` | （待收口卡按语义翻译） | 438 |
| files.edit.notUtf8 | `文件不是 UTF-8 文本，暂不支持在线编辑` | （待收口卡按语义翻译） | 434 |
| files.edit.openFail | `打开编辑器失败：` | （待收口卡按语义翻译） | 441 |
| files.edit.saveFail | `保存失败：` | （待收口卡按语义翻译） | 463 |
| files.edit.saved | `已保存（{size}）` | （待收口卡按语义翻译） | 454 |
| files.edit.shaNote | `，保存时校验摘要` | （待收口卡按语义翻译） | 438 |
| files.edit.tooLarge | `文件过大，仅支持预览，不支持在线编辑` | （待收口卡按语义翻译） | 425 |
| files.empty.newFolder | `新建文件夹` | （待收口卡按语义翻译） | 302 |
| files.empty.text | `可以上传文件或新建文件夹；也可以先用上方「新建文件」建一个空文件再编辑。` | （待收口卡按语义翻译） | 295 |
| files.empty.title | `这个目录是空的` | （待收口卡按语义翻译） | 294 |
| files.empty.upload | `上传文件` | （待收口卡按语义翻译） | 296 |
| files.err.nameEmpty | `名称不能为空` | （待收口卡按语义翻译） | 138 |
| files.err.operationFailed | `操作失败：` | （待收口卡按语义翻译） | 95 |
| files.err.unknown | `未知错误` | （待收口卡按语义翻译） | 77 |
| files.hint.batch | `批量里单条失败不影响其他条目；失败项会逐条列出原因，可修好后重试。` | （待收口卡按语义翻译） | 89 |
| files.hint.chmod | `mode 用八进制；目录必须保留执行位（如 0755）。` | （待收口卡按语义翻译） | 85 |
| files.hint.conflict | `目标已存在：勾选「覆盖」后重试，或换一个名称。` | （待收口卡按语义翻译） | 83 |
| files.hint.copyConflict | `目标已存在：勾选「覆盖同名」后重试，或换一个目录。` | （待收口卡按语义翻译） | 87 |
| files.hint.extract | `解压先整包校验路径安全，含 .. / 绝对路径的条目会整包拒绝。` | （待收口卡按语义翻译） | 84 |
| files.hint.frameLimit | `单帧上限 8 MiB，大文件请先压缩或用终端上传。` | （待收口卡按语义翻译） | 82 |
| files.hint.rename | `只支持同目录改名；同名冲突时换个名字，要换目录请用「移动」。` | （待收口卡按语义翻译） | 88 |
| files.hint.restore | `原路径已有同名项：确认覆盖恢复，或先移走它。` | （待收口卡按语义翻译） | 90 |
| files.hint.search | `按文件名支持通配（如 *.log）；按内容只搜文本文件，单文件上限 1 MiB。` | （待收口卡按语义翻译） | 86 |
| files.kind.dir | `目录` | （待收口卡按语义翻译） | 346 |
| files.kind.file | `文件` | File | 346 |
| files.more | `更多操作：{name}` | （待收口卡按语义翻译） | 367 |
| files.name.dblclick | `双击改名（只改同目录下的名字）` | （待收口卡按语义翻译） | 348 |
| files.newFile | `新建文件` | （待收口卡按语义翻译） | 146 |
| files.newFolder | `新建目录` | New Folder | 146 |
| files.op.chmod | `权限` | （待收口卡按语义翻译） | 360 |
| files.op.copyTo | `复制到` | （待收口卡按语义翻译） | 985 |
| files.op.copyToMenu | `复制到…` | （待收口卡按语义翻译） | 359 |
| files.op.delete | `删除` | （待收口卡按语义翻译） | 362 |
| files.op.download | `下载` | （待收口卡按语义翻译） | 356 |
| files.op.extract | `解压` | （待收口卡按语义翻译） | 357 |
| files.op.move | `移动` | （待收口卡按语义翻译） | 361 |
| files.op.rename | `改名` | （待收口卡按语义翻译） | 358 |
| files.preview.binaryNoPreview | `二进制文件，不支持预览；可用「下载」保存到本机` | （待收口卡按语义翻译） | 502 |
| files.preview.dirNoPreview | `目录不预览；点击左侧进入。` | （待收口卡按语义翻译） | 498 |
| files.preview.edit | `编辑` | （待收口卡按语义翻译） | 493 |
| files.preview.editAria | `编辑文件：{name}` | （待收口卡按语义翻译） | 483 |
| files.preview.hint | `点击左侧文件预览内容；目录请点击进入。` | （待收口卡按语义翻译） | 472 |
| files.preview.partial | `仅预览前 {size}；完整内容请下载` | （待收口卡按语义翻译） | 508 |
| files.preview.readFail | `读取失败：` | （待收口卡按语义翻译） | 510 |
| files.preview.readonlyAria | `文件内容（只读预览）：{name}` | （待收口卡按语义翻译） | 507 |
| files.preview.saveHint | `保存会用乐观锁校验；被其他会话改过会提示刷新。` | （待收口卡按语义翻译） | 485 |
| files.preview.title | `文件预览` | （待收口卡按语义翻译） | 1038 |
| files.purge.ack | `我已知晓：彻底删除后无法恢复` | （待收口卡按语义翻译） | 845 |
| files.purge.all | `将永久删除回收站里的全部 {n} 项。` | （待收口卡按语义翻译） | 841 |
| files.purge.confirm | `彻底删除` | （待收口卡按语义翻译） | 849 |
| files.purge.done | `已彻底删除 {n} 项，无法恢复` | （待收口卡按语义翻译） | 883 |
| files.purge.doneSummary | `彻底删除完成：成功 {ok} 项，失败 {fail} 项` | （待收口卡按语义翻译） | 885 |
| files.purge.failDetail | `失败明细：` | （待收口卡按语义翻译） | 884 |
| files.purge.noItems | `没有可彻底删除的项：请先勾选，或回收站本身是空的` | （待收口卡按语义翻译） | 870 |
| files.purge.selected | `将永久删除选中的 {n} 项。` | （待收口卡按语义翻译） | 841 |
| files.purge.title | `彻底删除确认（不可恢复）` | （待收口卡按语义翻译） | 839 |
| files.purge.warn | `彻底删除后无法恢复，也无法从本页找回。` | （待收口卡按语义翻译） | 842 |
| files.refresh | `刷新` | （待收口卡按语义翻译） | 967 |
| files.rename.conflict | `同名已存在，换个名字` | （待收口卡按语义翻译） | 917 |
| files.rename.done | `已改名：{from} → {to}` | （待收口卡按语义翻译） | 913 |
| files.rename.fail | `改名失败：` | （待收口卡按语义翻译） | 918 |
| files.rename.invalid | `名称不合法：不能为空、不能含 / 或 \\，也不能是保留名 .trash` | Invalid name: cannot be empty, cannot contain / or \, and reserved name .trash is not allowed | 907 |
| files.rename.newNameAria | `新名称（同目录改名）` | （待收口卡按语义翻译） | 899 |
| files.search.ariaContent | `按内容搜索` | （待收口卡按语义翻译） | 596 |
| files.search.ariaName | `按文件名搜索` | （待收口卡按语义翻译） | 596 |
| files.search.byContent | `按内容` | （待收口卡按语义翻译） | 625 |
| files.search.byName | `按文件名` | （待收口卡按语义翻译） | 625 |
| files.search.clear | `清除搜索` | Clear Search | 1013 |
| files.search.clearEmpty | `清空搜索` | （待收口卡按语义翻译） | 668 |
| files.search.colHit | `命中` | （待收口卡按语义翻译） | 675 |
| files.search.colPath | `路径` | （待收口卡按语义翻译） | 675 |
| files.search.countMatch | `{n} 项匹配` | （待收口卡按语义翻译） | 663 |
| files.search.done | `搜索完成：{matched} 项匹配，扫描 {scanned} 项{skip}{note}` | （待收口卡按语义翻译） | 634 |
| files.search.emptyQuery | `搜索关键词不能为空：按文件名填 *.log 之类，按内容填要查的文字` | （待收口卡按语义翻译） | 624 |
| files.search.emptyText | `换个关键词，或切换「按文件名 / 按内容」；内容搜索会跳过二进制与超过 1 MiB 的文件。` | （待收口卡按语义翻译） | 667 |
| files.search.emptyTitle | `没有找到匹配项` | （待收口卡按语义翻译） | 666 |
| files.search.fail | `搜索失败：` | （待收口卡按语义翻译） | 636 |
| files.search.go | `搜索` | （待收口卡按语义翻译） | 1010 |
| files.search.hint | `按文件名：支持 * 通配；按内容：在文本文件里找关键词（单文件 ≤ 1 MiB）` | （待收口卡按语义翻译） | 1016 |
| files.search.hintContent | `按内容：只搜文本文件，单文件 ≤ 1 MiB，二进制会跳过` | （待收口卡按语义翻译） | 601 |
| files.search.hintName | `按文件名：支持 * 通配；直接输入 report 会自动按 *report* 匹配` | （待收口卡按语义翻译） | 600 |
| files.search.inputAria | `搜索关键词` | （待收口卡按语义翻译） | 1007 |
| files.search.line | `第 {line} 行 ` | （待收口卡按语义翻译） | 687 |
| files.search.nameMatch | `文件名匹配` | （待收口卡按语义翻译） | 690 |
| files.search.placeholderContent | `文件内容里的关键词，如 timeout` | （待收口卡按语义翻译） | 595 |
| files.search.placeholderName | `文件名，如 *.log 或 report` | （待收口卡按语义翻译） | 595 |
| files.search.result | `搜索结果` | Search Results | 572 |
| files.search.searching | `正在{mode}搜索「{q}」…` | （待收口卡按语义翻译） | 625 |
| files.search.skipped | `，跳过 {n} 项（二进制/超大文件）` | （待收口卡按语义翻译） | 634 |
| files.search.truncated | `（结果较多，只显示前 {n} 条，请进入子目录或换更精确的关键词）` | （待收口卡按语义翻译） | 633 |
| files.select | `选择` | （待收口卡按语义翻译） | 336 |
| files.selectAll | `全选当前目录` | （待收口卡按语义翻译） | 313 |
| files.selectForCopy | `请先勾选或点选一个文件，再点「复制到」` | （待收口卡按语义翻译） | 990 |
| files.selectForRename | `请先勾选或点选一个文件，再点「改名」` | （待收口卡按语义翻译） | 975 |
| files.selectItem | `选择 {name}` | （待收口卡按语义翻译） | 339 |
| files.selected | `已选 {n} 项` | （待收口卡按语义翻译） | 237 |
| files.status.loading | `正在读取 {path}…` | （待收口卡按语义翻译） | 522 |
| files.status.readFail | `读取失败：` | （待收口卡按语义翻译） | 539 |
| files.status.total | `共 {n} 项 · {path}` | （待收口卡按语义翻译） | 537 |
| files.subtitle | `浏览、上传、下载、压缩、解压、改权限与移动；路径始终以根目录相对形式显示。` | （待收口卡按语义翻译） | 933 |
| files.tab.files | `文件` | Files | 1023 |
| files.tab.trash | `回收站` | （待收口卡按语义翻译） | 570 |
| files.title | `文件管理` | （待收口卡按语义翻译） | 932 |
| files.trash.available | `回收站有 {n} 项可恢复：点上方「回收站」查看或还原` | （待收口卡按语义翻译） | 709 |
| files.trash.back | `返回文件列表` | （待收口卡按语义翻译） | 749 |
| files.trash.colDeletedAt | `删除时间` | （待收口卡按语义翻译） | 766 |
| files.trash.colType | `类型` | （待收口卡按语义翻译） | 766 |
| files.trash.corrupt | `（另有 {n} 项元数据损坏，未列出）` | （待收口卡按语义翻译） | 731 |
| files.trash.empty | `清空回收站` | （待收口卡按语义翻译） | 761 |
| files.trash.emptyText | `在文件列表里删除项目时不会立刻销毁，会先移到这里，随时可以恢复。` | （待收口卡按语义翻译） | 748 |
| files.trash.emptyTitle | `回收站是空的` | （待收口卡按语义翻译） | 747 |
| files.trash.kindLink | `链接` | （待收口卡按语义翻译） | 780 |
| files.trash.limit | `，仅显示最近 200 项` | （待收口卡按语义翻译） | 732 |
| files.trash.loading | `正在读取回收站…` | （待收口卡按语义翻译） | 724 |
| files.trash.moveConfirm | `移入回收站确认` | （待收口卡按语义翻译） | 180 |
| files.trash.overwriteConfirm | `覆盖恢复确认` | （待收口卡按语义翻译） | 815 |
| files.trash.overwriteText | `{n} 项的原路径已被占用。可以先在原目录把同名项改名或移走，再回来恢复；也可以直接覆盖恢复（文件替换文件、空目录替换空目录）。` | （待收口卡按语义翻译） | 816 |
| files.trash.purge | `彻底删除` | （待收口卡按语义翻译） | 787 |
| files.trash.purgeSelected | `彻底删除所选` | （待收口卡按语义翻译） | 758 |
| files.trash.readFail | `读取回收站失败：` | （待收口卡按语义翻译） | 735 |
| files.trash.restore | `恢复` | （待收口卡按语义翻译） | 785 |
| files.trash.restoreDone | `恢复完成：成功 {ok} 项，失败 {fail} 项：{detail}` | （待收口卡按语义翻译） | 797 |
| files.trash.restoreNoSel | `请先勾选要恢复的项，或在行内点「恢复」` | （待收口卡按语义翻译） | 802 |
| files.trash.restoreSelected | `恢复所选` | （待收口卡按语义翻译） | 755 |
| files.trash.restored | `已恢复 {n} 项到原路径` | （待收口卡按语义翻译） | 796 |
| files.trash.restoring | `正在恢复 {n} 项…` | （待收口卡按语义翻译） | 803 |
| files.trash.total | `回收站共 {n} 项{limit}{corrupt}` | （待收口卡按语义翻译） | 732 |
| files.upload | `上传` | （待收口卡按语义翻译） | 939 |

## 收口注意事项
- 只写 en-US.js，zh-CN.js 不写（中文 fallback 已内联视图）
- 占位符原样保留：{name}/{n}/{size}/{note}/{path}/{q}/{line}/{from}/{to}/{ok}/{fail}/{detail} 等
- files.kind.file=File（类型列）vs files.tab.files=Files（标签页）——两者不可混用
- db.unit.* 三条中文原值前导空格为拼接用（秒/个库/行），英文译文需保留对应前导空格
- db.hint.accessDenied 中 `<新密码>` → `<new password>`（占位符换语言不换结构）
- files.rename.invalid 英文含反斜杠 `/ or \`——照抄，勿转义丢失
- 高频映射 19 条已照抄三张卡建议英译；其余 255 条由收口卡按中文语义翻译
