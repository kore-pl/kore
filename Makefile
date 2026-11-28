# kore — 极简内核驱动 · 插件定义能力 · 资源零侵占
# M0 骨架构建入口：只有骨架与门禁，无业务代码。
# 契约（ADR-0016）：硬红线 主壳空载 RSS ≤ 16 MiB · 单常驻插件 ≤ 24 MiB · 合计 ≤ 48 MiB · 同时常驻 ≤ 3；目标 主壳 8 MiB · 单插件 12 MiB · 合计 24 MiB · 单二进制 ≤ 25 MiB · 前端首屏 ≤ 300 KiB gzip · 运行时锚点（ADR-0015）默认 GOGC=50 + GOMEMLIMIT=6MiB + GOMAXPROCS=8（可被同名环境变量覆盖做消融对照，门禁见 canonical-check 规则 2）
# 约定：所有 recipe 必须 tab 缩进；输出统一 [OK]/[SKIP]/[N/A]/[FAIL] 前缀。

# ── 兼容性基线（ADR-0009 落地 · G-16）──
# GOAMD64=v1：x86-64 的 SSE2 基线，2003 年后量产的 CPU 全兼容；显式钉死、不继承构建机的 GOAMD64。
#   kore 是薄壳调度内核，无 SIMD 热点，v2/v3 的指令级收益可忽略，换的是"任何 amd64 机器都能跑"。
# GOARM64=v8.0：arm64 基线（Go 1.21+），不要求 ARMv9 特性。
# CGO_ENABLED=0：纯静态单二进制，不耦合 glibc 版本，RHEL8 / Alpine(musl) / 各 LTS 同一份产物可跑（Tier A）。
# -buildvcs=false：不把构建机 git 状态（commit / 脏标记）编进二进制，保证可复现。
# 五目标矩阵（ADR-0009/0010）：linux/amd64 · linux/arm64 · windows/amd64 · darwin/arm64 · darwin/amd64。
#   Linux 为 Tier A；Windows 10 1809+ / macOS 12+ 为 Tier B（降级支持，隔离与限额降级）。
# 产物：make build → bin/kored（本机）；make cross → 五目标「全仓 go build ./...」+ bin/kored-<os>-<arch>[.exe]；
# 阻断门禁：make cross-build（复用 cross 五目标全仓真编译，已并入 make check 第 17 段）；信息核对见 make compat-info。
# 覆盖边界：go build 不编译 _test.go —— 测试包的跨平台类型检查见 make cross-vet（信息入口，实测热 +1.7s，故不入第 17 段）。
# 覆盖边界 2：pkg/pluginapi 是**嵌套 module**（自带 go.mod），根 ./... 不遍历它 —— 它的测试由
#   make check 第 21 段（scripts/pluginapi-race-check.sh，cd pkg/pluginapi && go test -race ./...）覆盖。

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

APP       ?= kored
# VERSION 是内核**唯一**的版本声明：`make build` 经 LDFLAGS -X main.version 注入，
# `kored version`、插件安装时的 requires_kore 判定都读它。
# 0.1.1 = 首个含 file_write 受控写（ADR-0052 K3）的内核版本；使用 file_write 的插件
# 必须声明 requires_kore 下界 ≥0.1.1（自洽断言：make version-check，G-14）。
VERSION   ?= 0.1.4
CMD       ?= ./cmd/kored
BIN       ?= ./bin/kored
# 零侵入安装（ADR-0023）：默认 PREFIX=/opt/kore → 二进制 <install>/bin/kored，
# 状态/日志/socket 全在 <install> 内。覆盖成 /usr/local 会落进系统目录（fhs 形态）。
PREFIX    ?= /opt/kore
BINDIR    ?= $(PREFIX)/bin
UNITDIR   ?= /etc/systemd/system
UNITNAME  ?= kore.service
GO        ?= go
GOFLAGS   ?=
GOAMD64   ?= v1
GOARM64   ?= v8.0
# 注意：-buildvcs=false 是 `go build` 的构建标志，不是链接器标志。
# 写进 -ldflags 会让 cmd/link 报 "flag provided but not defined: -buildvcs"（已实测：exit 1）。
BUILDFLAGS := -trimpath -buildvcs=false
LDFLAGS    := -s -w -X main.version=$(VERSION)

# 资源预算（G-03/G-19）：单位 KiB / 字节。改口径只改这里，别散落到 recipe。
# 采样档：日常 5 点（约 10s，CI/迭代用）/ 收口 MEM_POINTS=60（约 65s，里程碑证据用）
MEM_POINTS      ?= 5
MEM_INTERVAL    ?= 1
MEM_SETTLE      ?= 5

# 硬红线（判未完成）：超过即 FAIL。主壳 ≤16 MiB · 单插件 ≤24 MiB · 合计 ≤48 MiB
MAIN_RSS_KIB_RED   ?= 16384
PLUGIN_RSS_KIB_RED ?= 24576
TOTAL_RSS_KIB_RED  ?= 49152
MAX_PLUGINS        ?= 3
# 目标（只 WARN，不阻断）：红线 ≥ x > 目标 记趋势。主壳 8 · 单插件 12 · 合计 24 MiB
MAIN_RSS_KIB_GOAL   ?= 8192
PLUGIN_RSS_KIB_GOAL ?= 12288
TOTAL_RSS_KIB_GOAL  ?= 24576
# 其它红线：单二进制 ≤ 25 MiB
BIN_MAX_BYTES   ?= 26214400
IDLE_CPU_MS_MAX ?= 60
GOROUTINES_MAX  ?= 20
FD_MAX          ?= 64

.PHONY: help build cross cross-build cross-vet compat-info vet test race race-full pluginapi-race web-dist frontend mem idle budget-check docs-check secret-check repo-check canonical-check log-check wt-check oss-check case-check store-check presets-check version-check check clean fmt

help: ## 显示本帮助（默认目标）
	@echo "$(APP) $(VERSION) — 极简内核驱动 · 插件定义能力 · 资源零侵占"
	@echo ""
	@echo "用法: make <target>"
	@echo ""
	@awk 'BEGIN { FS = ":.*##" } /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# web-dist 保证 embed 需要的 web/dist 主壳产物存在：web/dist 被 .gitignore 忽略，
# 干净检出直接 make build / vet / test 会因 //go:embed 找不到文件而失败（实测 exit 2）。
# 四十三个文件 = 首屏六件套（index/style/app/shell + i18n.js + i18n-zh-CN.js）+ 二十二个视图模块
# （store/files/sites/tasks/monitor/settings/terminal/db/logs/process/ssl/backups/redis/firewall/waf/dns/sshguard/runtimes/integrity/container/discover）
# + 八个按需子模块（files-l2 / site-edit / config-panel / monitor-cards / db-l2 / search / audit / alerts）
# + 五个个性化组件（onboarding.js/css、theme.js/css、shortcuts.js；shell 首屏后懒加载，不进首屏六件套）
# + 英文包（i18n/en-US.js，运行期按需注入，不进首屏）。
# 只在缺失或源更新时拷贝，不删目录、不跑体积门禁，开销为几次 stat。
WEB_SRC_FILES := index.html app.js style.css shell.js i18n.js store.js files.js files-l2.js sites.js site-edit.js config-panel.js tasks.js monitor.js monitor-cards.js settings.js security.js terminal.js db.js db-l2.js db-mysql.js db-postgres.js logs.js process.js ssl.js backups.js redis.js firewall.js waf.js dns.js sshguard.js runtimes.js integrity.js container.js appdeploy.js discover.js search.js audit.js alerts.js credentials.js onboarding.js onboarding.css theme.js theme.css shortcuts.js health.js calendar.js batch.js report.js topology.js snapshot.js webhook.js webhook.css migrate.js site-migrate.js alert-rules.js disk-analysis.js fault-drill.js macros.js cert-lifecycle.js config-drift.js slow-query.js log-alerts.js user-center.js plugins-view.js
# 语言包源码在 web/i18n/ 下，产物拍平成 web/dist/i18n-<locale>.js：
# 内核静态路由只托管「单段文件名」（server.go handleAsset 拒绝含 / 的路径），
# 不为了子目录去放宽内核的遍历面（ADR-0021）。

web-dist:
	@mkdir -p web/dist; \
	for f in $(WEB_SRC_FILES); do \
	  if [ ! -f "web/$$f" ]; then continue; fi; \
	  if [ ! -f "web/dist/$$f" ] || [ "web/$$f" -nt "web/dist/$$f" ]; then cp "web/$$f" "web/dist/$$f"; fi; \
	done; \
	if [ ! -f web/dist/i18n-zh-CN.js ] || [ web/i18n/zh-CN.js -nt web/dist/i18n-zh-CN.js ]; then cp web/i18n/zh-CN.js web/dist/i18n-zh-CN.js; fi; \
	if [ ! -f web/dist/i18n-en-US.js ] || [ web/i18n/en-US.js -nt web/dist/i18n-en-US.js ]; then cp web/i18n/en-US.js web/dist/i18n-en-US.js; fi

build: web-dist ## 构建主壳二进制（本机 GOOS/GOARCH；cmd/kored 未就绪时 SKIP）
	@if [ ! -d "$(CMD)" ]; then echo "[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现"; exit 0; fi; \
	mkdir -p $(dir $(BIN)); \
	CGO_ENABLED=0 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o $(BIN) $(CMD); \
	echo "[OK] 构建完成: $(BIN)"

# 全仓可编译口径（G-16 补全）：go build ./... 覆盖全部**非测试**包——含只被测试 / 工具 / 未来入口引用、
# 不在 $(CMD) 依赖闭包内的包（旧口径只编译 $(CMD) 闭包，这类包漏检）。
# 【不要用 `go build -o <dir>/ ./...` 代替】实测（go1.26.8）：多包 + `-o <目录>/` 只产出 main 包二进制，
# **静默跳过非 main 包的编译错误**（注入 undefined 探针：`go build ./...` rc=1，`-o dir/` rc=0）——那是假绿门禁。
# 所以必须用无 `-o` 的 `go build ./...`；它会把 main 包产物写到 cwd，构建立刻按 go list 算出的 main 包名清掉
# （不写死 kored / kored.exe：未来新增 cmd 子命令也自动覆盖）。产物名来自 `go list` 而非硬编码，避免漏删污染工作树。
CROSS_TRIPLES ?= linux/amd64 linux/arm64 windows/amd64 darwin/arm64 darwin/amd64

cross: web-dist ## 交叉编译五目标：全仓 go build ./... + kored 五产物
	@if [ ! -f go.mod ]; then echo "[SKIP] go.mod 未就绪（M0 阶段正常），M1 实现"; exit 0; fi; \
	mains=$$($(GO) list -f '{{if eq .Name "main"}}{{.Dir}}{{end}}' ./... | while read -r d; do [ -n "$$d" ] && basename "$$d"; done); \
	for t in $(CROSS_TRIPLES); do \
	  os=$${t%/*}; arch=$${t#*/}; \
	  echo "[..] 全仓编译 $$os/$$arch"; \
	  rc=0; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch GOAMD64=$(GOAMD64) GOARM64=$(GOARM64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) ./... || rc=$$?; \
	  for m in $$mains; do rm -f "./$$m" "./$$m.exe"; done; \
	  if [ $$rc -ne 0 ]; then echo "[FAIL] 全仓编译失败: $$os/$$arch（平台专有符号收进 internal/platform 或按 build tag 收口）"; exit 1; fi; \
	done; \
	echo "[OK] 全仓五目标可编译（go build ./...，不含 _test.go）"; \
	if [ ! -d "$(CMD)" ]; then echo "[SKIP] $(CMD) 未就绪（M0 阶段正常），五产物跳过"; exit 0; fi; \
	mkdir -p $(dir $(BIN)); \
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-linux-amd64 $(CMD); \
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOARM64=$(GOARM64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-linux-arm64 $(CMD); \
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-windows-amd64.exe $(CMD); \
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 GOARM64=$(GOARM64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-darwin-arm64 $(CMD); \
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-darwin-amd64 $(CMD); \
	echo "[OK] 交叉产物: linux-amd64 · linux-arm64 · windows-amd64.exe · darwin-arm64 · darwin-amd64"

cross-build: ## 交叉编译门禁（G-16 阻断级）：复用 cross 五目标全仓真编译，失败即阻断（make check 第 17 段）
	@echo "[INFO] 复用 make cross：五目标「全仓 go build ./...」+ kored 五产物；windows/amd64 + darwin/arm64 为 G-16 两条明文判据"; \
	start=$$(date +%s%N); \
	if out=$$($(MAKE) --no-print-directory cross 2>&1); then \
	  printf '%s\n' "$$out" | sed 's/^/       /'; \
	  ms=$$(( ($$(date +%s%N) - start) / 1000000 )); \
	  echo "[OK] 全仓交叉编译五目标全通过（exit 0，耗时 $${ms}ms）"; \
	else \
	  rc=$$?; \
	  ms=$$(( ($$(date +%s%N) - start) / 1000000 )); \
	  printf '%s\n' "$$out" | sed 's/^/       /'; \
	  first=$$(printf '%s\n' "$$out" | grep -m1 -E '^[^[:space:]#][^:]*\.go:[0-9]+:[0-9]+:' || true); \
	  echo "[FAIL] 交叉编译失败（exit $$rc，耗时 $${ms}ms）：平台专有符号必须收进 internal/platform 或按 build tag 收口"; \
	  if [ -n "$$first" ]; then echo "       首个编译错误: $$first"; fi; \
	  exit 1; \
	fi

compat-info: ## 打印构建参数与产物兼容信息（G-16 信息入口；阻断判据在 make cross-build）
	@echo "[INFO] go env（构建机默认值，不等于本仓库构建参数）:"; \
	for k in GOOS GOARCH GOAMD64 GOARM64 CGO_ENABLED; do printf '         %-14s %s\n' "$$k" "$$($(GO) env $$k)"; done; \
	echo "[INFO] 本仓库强制构建参数（G-16）: CGO_ENABLED=0 GOAMD64=$(GOAMD64) GOARM64=$(GOARM64) -trimpath -buildvcs=false"; \
	if ! ls bin/kored* >/dev/null 2>&1; then \
	  echo "[SKIP] bin/kored* 未构建（M0 阶段正常），M1 起可看文件类型与构建信息"; \
	else \
	  echo "[INFO] file bin/kored*（按 GOOS/GOARCH 核对目标平台）:"; \
	  if command -v file >/dev/null 2>&1; then file bin/kored* | sed 's/^/         /'; else echo "         (file 命令不可用)"; fi; \
	  if [ -f "$(BIN)" ]; then \
	    echo "[INFO] go version -m $(BIN)（摘要，含 GOOS/GOAMD64/buildvcs 设置）:"; \
	    $(GO) version -m "$(BIN)" | head -12 | sed 's/^/         /'; \
	  else \
	    echo "         ($(BIN) 不存在，跳过构建信息)"; \
	  fi; \
	fi; \
	if [ -f go.mod ]; then echo "[INFO] 交叉编译冒烟（五目标全仓 ./... + 五产物）:"; $(MAKE) --no-print-directory cross; else echo "[N/A] go.mod 未就绪（M0 阶段正常），交叉编译冒烟跳过，M1 起生效"; fi

# 测试包跨平台类型检查（信息入口，不入第 17 段）：go build 不编译 _test.go，`go vet` 会类型检查测试包，
# 这是「全仓可跨平台」之外唯一能覆盖测试包的本地手段。实测代价：热 +1.7s（windows 1.06s + darwin 0.69s）、
# 冷 +4.0s——与第 17 段本体同量级（会让该段热态翻倍），不塞进每次 check，改测试包时显式运行。
cross-vet: web-dist ## 测试包跨平台类型检查（信息入口）：GOOS=windows/darwin go vet ./...（含 _test.go，不入第 17 段）
	@if [ ! -f go.mod ]; then echo "[SKIP] go.mod 未就绪（M0 阶段正常），M1 实现"; exit 0; fi; \
	for t in windows/amd64 darwin/arm64; do \
	  os=$${t%/*}; arch=$${t#*/}; \
	  echo "[..] vet ./...（含测试包） $$os/$$arch"; \
	  if ! CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch GOAMD64=$(GOAMD64) GOARM64=$(GOARM64) GOFLAGS="$(GOFLAGS)" $(GO) vet ./...; then \
	    echo "[FAIL] 测试包跨平台类型检查失败: $$os/$$arch（测试里的平台专有用法要加 build tag）"; exit 1; \
	  fi; \
	done; \
	echo "[OK] 测试包跨平台类型检查通过（windows/amd64 · darwin/arm64，go vet 含 _test.go）"

vet: web-dist ## go vet 静态检查（源码未就绪时 SKIP）
	@if [ ! -f go.mod ] || { [ ! -d ./cmd ] && [ ! -d ./internal ]; }; then echo "[SKIP] 源码未就绪（无 go.mod 或 cmd/internal 缺失），M1 实现"; exit 0; fi; \
	$(GO) vet ./...; \
	echo "[OK] go vet 通过"

test: web-dist ## 运行单元测试（根 module + 嵌套 module pkg/pluginapi；源码未就绪时 SKIP）
	@if [ ! -f go.mod ] || { [ ! -d ./cmd ] && [ ! -d ./internal ]; }; then echo "[SKIP] 源码未就绪（无 go.mod 或 cmd/internal 缺失），M1 实现"; exit 0; fi; \
	$(GO) test -timeout 200s ./...; \
	if [ -f pkg/pluginapi/go.mod ]; then echo "[..] 嵌套 module pkg/pluginapi（根 ./... 不遍历）：cd pkg/pluginapi && go test ./..."; ( cd pkg/pluginapi && GOWORK=off $(GO) test -timeout 200s ./... ) || exit 1; fi; \
	echo "[OK] go test 通过（根 module + 嵌套 module pkg/pluginapi）"

# race 门禁（本仓，第 18 段口径）：只对 ./tests/boundary/ 加 -race。并发断言集中在那里；
# 跨仓接线 + 真跑见 scripts/race-gate-check.sh（make check 第 18 段）。
# -race 需要 cgo（本地 gcc / CI ubuntu-latest 自带）。
race: ## -race 跑并发边界用例（本仓无 ./tests/boundary/ 时 SKIP）
	@if [ ! -d tests/boundary ]; then echo "[SKIP] 本仓无 tests/boundary：race 门禁无目标（新增后自动生效）"; exit 0; fi; \
	echo "[RUN ] race: CGO_ENABLED=1 $(GO) test -race -count=1 -timeout 300s ./tests/boundary/..."; \
	CGO_ENABLED=1 $(GO) test -race -count=1 -timeout 300s ./tests/boundary/...

# 全仓 -race（第 19 段）：kore 本仓没有 tests/boundary/ → 上面那段恒 [SKIP]，本仓代码在
# race detector 面前是零覆盖。bd3ac83 在 cmd/kored 修的两处真实竞争只有 -race 能发现
# （普通 go test 全绿、断言全过），所以把全仓 -race 单列一段，固定面 ./... 必绿。
# 实测 52s：cmd/kored 51.7s 主导，go test 包级并行 → internal/* 合计只多 0.47s，
# 「只跑 ./internal/... + ./cmd/kored 省时间」不成立（等价 52s，却少覆盖 ./web）。
# web-dist 前置：web/embed.go 用 //go:embed 嵌 web/dist，干净树上没有它 → 全包 setup failed；
# 该目标只做本地文件拷贝（无 npm / 无网络），与 vet / test 同约定。
race-full: web-dist ## 全仓 -race（数据竞争检测，第 19 段，实测约 52s）
	@bash scripts/race-full-check.sh

# 嵌套 module 门禁（第 21 段）：pkg/pluginapi 自带 go.mod，根 module 的 ./... **不遍历**它
# （实测根 go list ./... = 18 包 / 0 pluginapi），所以第 17/19 段都盖不到它的 12 个测试文件。
# 判据本体在脚本里：固定面 ./...、失败阻断、缺 cgo 直接 FAIL、一个包没跑到也 FAIL。
pluginapi-race: ## pkg/pluginapi（嵌套 module）全量 -race（第 21 段，阻断级，实测约 1.3s）
	@bash scripts/pluginapi-race-check.sh

frontend: web-dist ## 构建前端产物并核对首屏体积（M2-D：零依赖静态拷贝 + gzip ≤300 KiB）
	@if [ ! -f web/index.html ] || [ ! -f web/app.js ] || [ ! -f web/style.css ]; then echo "[SKIP] web/ 壳未就绪，M2 实现"; exit 0; fi; \
	for f in $(WEB_SRC_FILES); do \
	  if [ ! -f "web/$$f" ]; then echo "[SKIP] web/$$f 缺失（主壳产物不齐），M2 实现"; exit 0; fi; \
	done; \
	rm -rf web/dist; \
	mkdir -p web/dist; \
	cp $(addprefix web/,$(WEB_SRC_FILES)) web/dist/; \
	cp web/i18n/zh-CN.js web/dist/i18n-zh-CN.js; \
	cp web/i18n/en-US.js web/dist/i18n-en-US.js; \
	echo "[OK] 前端静态产物已打包: web/dist（$$(( $(words $(WEB_SRC_FILES)) + 2 )) 文件，零依赖；首屏 6 件套 + 22 视图模块 + 插件管理视图 + 按需子模块/组件 + 英文包）"; \
	bash scripts/frontend-check.sh

mem: ## 采样 VmRSS：日常 5 点 ≈10s（默认）/ 收口 MEM_POINTS=60 ≈65s；含 RssAnon/RssFile 诊断（目标 8192 / 红线 16384 KiB）
	@echo "[INFO] 预算（G-03）：主壳 VmRSS 目标 $(MAIN_RSS_KIB_GOAL) / 红线 $(MAIN_RSS_KIB_RED) KiB · 单插件 目标 $(PLUGIN_RSS_KIB_GOAL) / 红线 $(PLUGIN_RSS_KIB_RED) KiB · 合计 目标 $(TOTAL_RSS_KIB_GOAL) / 红线 $(TOTAL_RSS_KIB_RED) KiB · 常驻插件数 ≤$(MAX_PLUGINS)"
	@echo "[INFO] 采样规格（G6）：稳定期 $(MEM_SETTLE)s → $(MEM_POINTS) 点 × $(MEM_INTERVAL)s 间隔；主值 VmRSS（ps -o rss=，等价 /proc/<pid>/status 的 VmRSS）；RssAnon/RssFile 仅诊断，不设绝对上限；GC 档位以启动日志「资源锚点」行为准（environ 不可见程序内 SetGCPercent）"
	@echo "[CMD ] ps -o rss= -p \$$(pgrep -x kored)"
	@pids=$$(pgrep -x kored 2>/dev/null || true); \
	if [ -z "$$pids" ]; then echo "[SKIP] 未发现运行中的 kored 进程（M0 阶段正常）；需启动 kored 后实测（默认 60 点 × $(MEM_INTERVAL)s ≈ $(MEM_SETTLE)s + $$(( $(MEM_POINTS) * $(MEM_INTERVAL) ))s）"; exit 0; fi; \
	pid1=$$(printf '%s\n' "$$pids" | head -n 1); \
	points=$(MEM_POINTS); interval=$(MEM_INTERVAL); settle=$(MEM_SETTLE); \
	if [ "$$points" -lt 1 ]; then points=1; fi; \
	echo "[INFO] kored PID: $$(printf '%s ' $$pids)"; \
	echo "[INFO] 生效环境变量（/proc/$$pid1/environ）："; \
	for k in GOGC GOMEMLIMIT; do v=$$(tr '\0' '\n' < /proc/$$pid1/environ 2>/dev/null | grep -E "^$$k=" || true); if [ -n "$$v" ]; then echo "         $$v"; else echo "         $$k=(未设；若由程序内 SetGCPercent/SetMemoryLimit 设定，真实档位见启动日志「资源锚点」)"; fi; done; \
	echo "[INFO] 稳定期 $${settle}s …（采样期间请勿压测）"; sleep $$settle; \
	samples=$$( i=0; while [ "$$i" -lt "$$points" ]; do i=$$((i + 1)); ps -o rss= -p $$pid1 2>/dev/null | tr -d ' '; sleep $$interval; done | sed '/^$$/d' ); \
	n=$$(printf '%s\n' "$$samples" | sed '/^$$/d' | wc -l); \
	if [ "$$n" -eq 0 ]; then echo "[FAIL] 采样为空（进程可能在采样期间退出）"; exit 1; fi; \
	if [ "$$n" -lt "$$points" ]; then echo "[WARN] 采样不完整：$$n/$$points 点（进程可能在采样期间抖动或退出，统计仅供参考）"; fi; \
	stats=$$(printf '%s\n' "$$samples" | sort -n | awk '{a[NR]=$$1} END {n=NR; if (n%2) med=a[(n+1)/2]; else med=int((a[n/2]+a[n/2+1])/2+0.5); x=0.95*n; idx=int(x); if (x>idx) idx++; if (idx<1) idx=1; if (idx>n) idx=n; printf "%d %d %d %d\n", med, a[1], a[n], a[idx]}'); \
	set -- $$stats; med=$$1; rmin=$$2; rmax=$$3; rp95=$$4; \
	elapsed=$$(( settle + points * interval )); \
	if [ "$$points" -ge 60 ]; then tier="收口($${points}点)"; else tier="日常($${points}点)"; fi; \
	echo "[INFO] 采样档：$$tier · 点数 $$n/$$points · 间隔 $${interval}s · 稳定期 $${settle}s · 总时长约 $${elapsed}s · 主值来源 VmRSS(ps -o rss=)"; \
	echo "[INFO] 主壳 VmRSS：中位数 $$med KiB · min $$rmin · max $$rmax · p95 $$rp95（中位数目标 $(MAIN_RSS_KIB_GOAL) / 红线 $(MAIN_RSS_KIB_RED) KiB）"; \
	anon=""; rfile=""; src=""; \
	for f in /proc/$$pid1/smaps_rollup /proc/$$pid1/status; do \
	  if [ -r "$$f" ]; then a=$$(awk '/^RssAnon:/{print $$2; exit}' "$$f" 2>/dev/null || true); b=$$(awk '/^RssFile:/{print $$2; exit}' "$$f" 2>/dev/null || true); if [ -n "$$a" ] && [ -n "$$b" ]; then anon=$$a; rfile=$$b; src="$$f"; break; fi; fi; \
	done; \
	if [ -z "$$anon" ]; then anon=$$(awk '/^RssAnon:/{s+=$$2} END{print s+0}' /proc/$$pid1/smaps 2>/dev/null || echo 0); rfile=$$(awk '/^RssFile:/{s+=$$2} END{print s+0}' /proc/$$pid1/smaps 2>/dev/null || echo 0); src="smaps 汇总（末级回退）"; fi; \
	echo "[INFO] 诊断拆分（来源 $$src；仅诊断，不设绝对上限）：RssAnon=$$anon KiB · RssFile=$$rfile KiB"; \
	prep=$$(ps -eo pid=,rss=,comm= 2>/dev/null | awk '$$3 ~ /^kore-plugin-/ {c++; r+=$$2; if ($$2>m) m=$$2} END {printf "%d %d %d", c+0, r+0, m+0}'); \
	set -- $$prep; pcount=$$1; ptotal=$$2; pmax=$$3; \
	echo "[INFO] 常驻插件进程数: $$pcount（阈值 ≤$(MAX_PLUGINS)）· 合计 RSS=$$ptotal KiB（目标 $(TOTAL_RSS_KIB_GOAL) / 红线 $(TOTAL_RSS_KIB_RED)）· 单进程最大=$$pmax KiB（目标 $(PLUGIN_RSS_KIB_GOAL) / 红线 $(PLUGIN_RSS_KIB_RED)）"; \
	s=0; \
	if [ "$$med" -gt "$(MAIN_RSS_KIB_RED)" ]; then echo "[FAIL] 主壳 VmRSS $$med KiB > 红线 $(MAIN_RSS_KIB_RED) KiB（判未完成）"; s=1; \
	elif [ "$$med" -gt "$(MAIN_RSS_KIB_GOAL)" ]; then echo "[WARN] 主壳 VmRSS $$med KiB 超出目标 $(MAIN_RSS_KIB_GOAL) KiB、未越红线 $(MAIN_RSS_KIB_RED) KiB（记趋势，不阻断）"; \
	else echo "[OK] 主壳 VmRSS $$med KiB ≤ 目标 $(MAIN_RSS_KIB_GOAL) KiB"; fi; \
	if [ "$$pcount" -le "$(MAX_PLUGINS)" ]; then echo "[OK] 常驻插件数 $$pcount ≤ $(MAX_PLUGINS)"; else echo "[FAIL] 常驻插件数 $$pcount > $(MAX_PLUGINS)"; s=1; fi; \
	if [ "$$ptotal" -gt "$(TOTAL_RSS_KIB_RED)" ]; then echo "[FAIL] 插件合计 RSS $$ptotal KiB > 红线 $(TOTAL_RSS_KIB_RED) KiB（判未完成）"; s=1; \
	elif [ "$$ptotal" -gt "$(TOTAL_RSS_KIB_GOAL)" ]; then echo "[WARN] 插件合计 RSS $$ptotal KiB 超出目标 $(TOTAL_RSS_KIB_GOAL) KiB、未越红线 $(TOTAL_RSS_KIB_RED) KiB（记趋势，不阻断）"; \
	else echo "[OK] 插件合计 RSS $$ptotal KiB ≤ 目标 $(TOTAL_RSS_KIB_GOAL) KiB"; fi; \
	if [ "$$pmax" -gt "$(PLUGIN_RSS_KIB_RED)" ]; then echo "[FAIL] 单插件最大 RSS $$pmax KiB > 红线 $(PLUGIN_RSS_KIB_RED) KiB（判未完成）"; s=1; \
	elif [ "$$pmax" -gt "$(PLUGIN_RSS_KIB_GOAL)" ]; then echo "[WARN] 单插件最大 RSS $$pmax KiB 超出目标 $(PLUGIN_RSS_KIB_GOAL) KiB、未越红线 $(PLUGIN_RSS_KIB_RED) KiB（记趋势，不阻断）"; \
	else echo "[OK] 单插件最大 RSS $$pmax KiB ≤ 目标 $(PLUGIN_RSS_KIB_GOAL) KiB"; fi; \
	if [ "$$s" -eq 0 ]; then echo "[OK] 内存判定完成（目标 $(MAIN_RSS_KIB_GOAL) · 红线 $(MAIN_RSS_KIB_RED) KiB；越线才阻断）"; else exit 1; fi

idle: ## 空载行为门禁（60s 窗口；空闲 CPU ≤60ms · 线程 ≤20 · fd ≤64 · 出站连接 0 · 定时器白名单）
	@pids=$$(pgrep -x kored 2>/dev/null || true); \
	if [ -z "$$pids" ]; then echo "[SKIP] 未发现运行中的 kored 进程（M0 阶段正常）；需启动 kored 后实测（M1 起生效）"; exit 0; fi; \
	pid=$$(printf '%s\n' "$$pids" | head -n 1); \
	clk=$$(getconf CLK_TCK 2>/dev/null || echo 100); \
	pass=0; fail=0; na=0; \
	echo "[INFO] kored PID=$$pid · CLK_TCK=$$clk · 提示：由当前 shell 直接启动可能继承父进程 fd，用 systemd/干净环境启动测量才准"; \
	sleep 5; a=$$(awk '{print $$14 + $$15}' /proc/$$pid/stat 2>/dev/null || true); th0=$$(awk '/^Threads:/{print $$2; exit}' /proc/$$pid/status 2>/dev/null || true); \
	if [ -z "$$a" ]; then echo "[FAIL] 无法读取 /proc/$$pid/stat（进程在采样开始前退出）"; exit 1; fi; \
	sleep 60; b=$$(awk '{print $$14 + $$15}' /proc/$$pid/stat 2>/dev/null || true); \
	if [ -z "$$b" ]; then echo "[FAIL] kored 在 60s 采样窗口内退出，本次测量作废"; exit 1; fi; \
	ms=$$(( (b - a) * 1000 / clk )); \
	if [ "$$ms" -le "$(IDLE_CPU_MS_MAX)" ]; then echo "[OK] 空闲 CPU: $$ms ms/60s（阈值 ≤$(IDLE_CPU_MS_MAX) ms）"; pass=$$((pass + 1)); else echo "[FAIL] 空闲 CPU: $$ms ms/60s > $(IDLE_CPU_MS_MAX) ms"; fail=$$((fail + 1)); fi; \
	th=$$(awk '/^Threads:/{print $$2; exit}' /proc/$$pid/status 2>/dev/null || true); \
	if [ -n "$$th" ]; then g="$$th"; src="Threads(/proc/status)"; elif [ -S /run/kore/kore.sock ] && command -v curl >/dev/null 2>&1; then g=$$(curl -s --unix-socket /run/kore/kore.sock /api/v1/system/info | sed -n 's/.*"goroutines":[ ]*\([0-9][0-9]*\).*/\1/p'); src="goroutines(/api/v1/system/info)"; else g=""; src="不可用"; fi; \
	if [ -z "$$g" ]; then echo "[N/A] 线程/goroutine 数不可得（无 Threads 且 socket API 不可用）"; na=$$((na + 1)); elif [ "$$g" -le "$(GOROUTINES_MAX)" ]; then echo "[OK] 线程数($$src): $$g（≤$(GOROUTINES_MAX)）"; pass=$$((pass + 1)); else echo "[FAIL] 线程数($$src): $$g > $(GOROUTINES_MAX)"; fail=$$((fail + 1)); fi; \
	if [ -n "$$th0" ] && [ -n "$$g" ]; then ds=$$((g - th0)); if [ "$$ds" -gt 2 ] || [ "$$ds" -lt -2 ]; then echo "[WARN] 线程数在 60s 内由 $$th0 变为 $$g（差 $$ds > 2，疑似轮询/泄漏，记趋势不阻断）"; else echo "[INFO] 线程数稳定：$$th0 → $$g（差 $$ds，≤2）"; fi; fi; \
	fds=$$(ls /proc/$$pid/fd 2>/dev/null | wc -l); \
	if [ "$$fds" -le "$(FD_MAX)" ]; then echo "[OK] 打开 fd: $$fds（≤$(FD_MAX)）"; pass=$$((pass + 1)); else echo "[FAIL] 打开 fd: $$fds > $(FD_MAX)"; fail=$$((fail + 1)); fi; \
	out=$$(ss -tnp 2>/dev/null | grep -c kored || true); out=$${out:-0}; \
	if [ "$$out" -eq 0 ]; then echo "[OK] 出站连接: 0（禁止主动外连）"; pass=$$((pass + 1)); else echo "[FAIL] 出站连接: $$out（阈值 0）"; fail=$$((fail + 1)); fi; \
	if [ -d internal ]; then tn=$$( { grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ --include='*.go' 2>/dev/null | grep -v cert_renew | grep -v '^internal/core/scheduler/' || true; } | wc -l); if [ "$$tn" -eq 0 ]; then echo "[OK] 周期性定时器零命中（Ticker/AfterFunc；白名单：internal/core/scheduler/ 目录与 cert_renew）；NewTimer 属请求级超时，不在此列（须 Stop()，由评审确认）"; pass=$$((pass + 1)); else echo "[FAIL] 周期性定时器 $$tn 处（Ticker/AfterFunc，白名单：internal/core/scheduler/ 目录与 cert_renew）"; grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ --include='*.go' 2>/dev/null | grep -v cert_renew | grep -v '^internal/core/scheduler/' | head -5 || true; fail=$$((fail + 1)); fi; else echo "[N/A] 源码未就绪（internal/ 缺失），周期性定时器检查跳过"; na=$$((na + 1)); fi; \
	echo "idle: $$pass pass, $$fail fail, $$na n/a"; \
	if [ "$$fail" -ne 0 ]; then exit 1; fi

budget-check: ## 资源预算聚合门禁（mem 5 点 ≈10s + idle ≈65s，默认约 80s；含进程数与二进制体积 ≤25 MiB）
	@fail=0; pass=0; skip=0; warn=0; \
	k0=$$(pgrep -x kored 2>/dev/null | wc -l | tr -d ' ' || true); k0=$${k0:-0}; \
	echo "[RUN ] 1/4 mem（VmRSS / RssAnon+RssFile 拆分 / 插件预算）"; \
	mem_rc=0; mem_out=$$($(MAKE) --no-print-directory mem 2>&1) || mem_rc=$$?; \
	printf '%s\n' "$$mem_out"; \
	if [ "$$mem_rc" -ne 0 ]; then echo "[FAIL] mem 越硬红线（已判未完成）"; fail=$$((fail + 1)); \
	elif [ "$$k0" -eq 0 ]; then echo "[SKIP] mem 无实测对象（M0 预期）"; skip=$$((skip + 1)); \
	elif printf '%s\n' "$$mem_out" | grep -q '^\[WARN\]'; then echo "[WARN] mem 超出目标、未越硬红线（记趋势，不阻断）"; warn=$$((warn + 1)); \
	else echo "[OK] mem 达标"; pass=$$((pass + 1)); fi; \
	echo ""; \
	echo "[RUN ] 2/4 idle（空闲 CPU / 线程 / fd / 出站连接 / 定时器）"; \
	idle_rc=0; idle_out=$$($(MAKE) --no-print-directory idle 2>&1) || idle_rc=$$?; \
	printf '%s\n' "$$idle_out"; \
	if [ "$$idle_rc" -ne 0 ]; then echo "[FAIL] idle 越硬红线（已判未完成）"; fail=$$((fail + 1)); \
	elif [ "$$k0" -eq 0 ]; then echo "[SKIP] idle 无实测对象（M0 预期）"; skip=$$((skip + 1)); \
	elif printf '%s\n' "$$idle_out" | grep -q '^\[WARN\]'; then echo "[WARN] idle 超出目标、未越硬红线（记趋势，不阻断）"; warn=$$((warn + 1)); \
	else echo "[OK] idle 达标"; pass=$$((pass + 1)); fi; \
	echo ""; \
	echo "[RUN ] 3/4 进程数（kored 1 个 + 常驻插件 ≤$(MAX_PLUGINS)）"; \
	p=$$(ps -eo comm= 2>/dev/null | grep -c '^kore-plugin-' || true); p=$${p:-0}; \
	if [ "$$k0" -eq 0 ]; then echo "[N/A] 未发现 kored 进程（M0 阶段正常）"; else if [ "$$k0" -gt 1 ]; then echo "[FAIL] kored 进程数 $$k0 > 1（不允许双主壳）"; fail=$$((fail + 1)); else echo "[OK] kored 进程数: 1"; pass=$$((pass + 1)); fi; if [ "$$p" -gt "$(MAX_PLUGINS)" ]; then echo "[FAIL] 常驻插件进程数 $$p > $(MAX_PLUGINS)"; fail=$$((fail + 1)); else echo "[OK] 常驻插件进程数: $$p（≤$(MAX_PLUGINS)）"; pass=$$((pass + 1)); fi; fi; \
	echo ""; \
	echo "[RUN ] 4/4 二进制体积（$(BIN) ≤ 25 MiB = $(BIN_MAX_BYTES) 字节）"; \
	if [ -f "$(BIN)" ]; then sz=$$(stat -c%s "$(BIN)"); if [ "$$sz" -le "$(BIN_MAX_BYTES)" ]; then echo "[OK] $(BIN): $$sz 字节（≤ 25 MiB）"; pass=$$((pass + 1)); else echo "[FAIL] $(BIN): $$sz 字节 > $(BIN_MAX_BYTES) 字节"; fail=$$((fail + 1)); fi; else echo "[N/A] $(BIN) 未构建（M0 阶段正常）"; fi; \
	echo ""; \
	echo "budget-check: $$pass pass, $$warn warn, $$skip skip, $$fail fail"; \
	if [ "$$fail" -ne 0 ]; then exit 1; fi

docs-check: ## 运行文档门禁（scripts/docs-check.sh）
	@echo "[RUN ] docs-check"
	@bash scripts/docs-check.sh

secret-check: ## 明文凭据门禁（docs/ 与 .agents/verify/ 中不得出现明文口令，G-30）
	@echo "[RUN ] secret-check"
	@bash scripts/secret-check.sh

zero-intrusion-check: ## 零侵入门禁（ADR-0023：隔离安装根下验证"删除目录即卸载"，含豁免项说明）
	@echo "[RUN ] zero-intrusion-check（ADR-0023）"
	@bash scripts/zero-intrusion-check.sh

# repo-check 说明：第 2、3 项（kore-plugin- 引用 / 旧 SDK 路径）排除 `.agents/verify/`：
# 那是冻结的验收证据，必然引用旧路径做对照；不排除会让"一次 FAIL 永久自锁"。
# 排除范围仅限 verify 目录，`.agents/` 其余文件（WORKFLOW / BOARD / ROLES 等）照常扫描。
# *.go 代码不因目录豁免而成例外——代码里出现旧路径仍是硬错误。
repo-check: ## 跨仓库边界检查（本仓库不含插件代码 / 插件 import / 插件索引）
	@pass=0; fail=0; \
	if [ -d plugins ] && find plugins -type f -name '*.go' | grep -q .; then \
	  echo "[FAIL] plugins/ 下发现插件代码（*.go）——插件属于 kore-plugin-<id> 独立仓库"; \
	  find plugins -type f -name '*.go' | head -5; \
	  fail=$$((fail + 1)); \
	else \
	  echo "[OK] 无插件代码目录（plugins/ 下无 *.go）"; \
	  pass=$$((pass + 1)); \
	fi; \
	if grep -rn --exclude-dir=.git --exclude-dir=verify --include='*.go' 'kore-plugin-' . >/dev/null 2>&1; then \
	  echo "[FAIL] 源码中出现 kore-plugin- 引用（内核不得 import 插件仓库）"; \
	  grep -rn --exclude-dir=.git --exclude-dir=verify --include='*.go' 'kore-plugin-' . | head -5 || true; \
	  fail=$$((fail + 1)); \
	else \
	  echo "[OK] 无任何 kore-plugin- 源码导入"; \
	  pass=$$((pass + 1)); \
	fi; \
	if grep -rn --exclude-dir=.git --exclude-dir=verify --include='*.go' --include='*.md' 'internal/pluginapi' . >/dev/null 2>&1; then \
	  echo "[FAIL] 仍引用旧 SDK 路径 internal/pluginapi（应为 pkg/pluginapi）"; \
	  grep -rn --exclude-dir=.git --exclude-dir=verify --include='*.go' --include='*.md' 'internal/pluginapi' . | head -5 || true; \
	  fail=$$((fail + 1)); \
	else \
	  echo "[OK] 无旧 SDK 路径（统一 pkg/pluginapi）"; \
	  pass=$$((pass + 1)); \
	fi; \
	if [ -e index/plugins.json ]; then \
	  echo "[FAIL] 本仓库出现 index/plugins.json——插件索引属于 kore-plugins 仓库"; \
	  fail=$$((fail + 1)); \
	else \
	  echo "[OK] 无插件索引 index/plugins.json（属 kore-plugins 仓库）"; \
	  pass=$$((pass + 1)); \
	fi; \
	if [ -f .gitmodules ] && grep -q 'kore-plugin-' .gitmodules; then \
	  echo "[FAIL] .gitmodules 含 kore-plugin-（插件不得 submodule 化）"; \
	  grep -n 'kore-plugin-' .gitmodules | head -5 || true; \
	  fail=$$((fail + 1)); \
	else \
	  echo "[OK] 无 submodule 化插件（.gitmodules 无 kore-plugin-）"; \
	  pass=$$((pass + 1)); \
	fi; \
	echo "repo-check: $$pass pass, $$fail fail"; \
	if [ "$$fail" -ne 0 ]; then exit 1; fi

canonical-check: ## 口径唯一性门禁（旧预算 / 旧字段 / 幽灵 id 清零 + 预算声明不丢）
	@echo "[RUN ] canonical-check"
	@bash scripts/canonical-check.sh

log-check: ## 判断留痕台账检查（.agents/LOG 三件套 + 条目数 + sessions；WARN 级不阻断）
	@echo "[RUN ] log-check"
	@bash scripts/log-check.sh

wt-check: ## worktree 卫生检查（工作树数 / wt-*分支 / .git/worktrees 元数据 / /tmp/wt- 路径；WARN 级不阻断）
	@echo "[RUN ] wt-check"
	@bash scripts/wt-check.sh

oss-check: ## 开源资产门禁（LICENSE / 根文档 / CI / 占位符 / Go 协议头；G-26）
	@echo "[RUN ] oss-check"
	@bash scripts/oss-check.sh

case-check: ## 大小写一致性门禁（module 路径全小写 / 同目录大小写冲突 / 插件 id / 文档 URL owner）
	@echo "[RUN ] case-check"
	@bash scripts/case-check.sh

store-check: ## 插件仓规范门禁（G-17：三件套 + info.json 必填 9 字段 + 描述类字段四选一（全缺 WARN）+ id/目录一致 + info/manifest 版本一致 + replace 跨仓拦截 + 本地 dist sha ↔ 索引 sha（WARN，DIST_SHA_DIFF）+ README 全文 dist/<id>-<ver>.tar.gz 引用版本 ↔ info.json.version（WARN，README_VERSION_DRIFT，带行号））
	@bash scripts/store-check.sh

presets-check: ## 预设一致性门禁（G-18：id / 版本区间可解析 + 常驻 RSS ≤48 MiB + 同时常驻 ≤3 + 包体积 + G-20：索引↔仓库 depth_level 一致性 / out_of_box 不含 non-production / 判据① 边界用例 go test 真跑）
	@bash scripts/presets-check.sh

# ── G-14 协议兼容自洽（版本断言 · 2026-11-24）──
# 为什么单独成一个目标而不并进 make check 21 段：它是**跨仓**判据（依赖 ../kore-plugin-*），
# 独立 clone 时必须能 SKIP；且它只回答「版本声明彼此打不打架」，不重复 store-check 的字段校验。
# 四条断言：
#   ① Makefile VERSION == cmd/kored/main.go 的内置默认值（否则 `go run` 与 `make build` 报不同版本）；
#   ② VERSION ∈ 每个插件 info.json 的 requires_kore 区间（下界含、上界不含，与
#      internal/core/installer/requires.go 的语义一致：插件装了跑不起来，是安装期就该拒的事）；
#   ③ 声明 file_write 的插件，requires_kore 下界必须 ≥0.1.1——0.1.1 是首个含受控写的内核版本，
#      声明了却不抬下界，等于允许装到旧内核上、运行时才 E_INVALID（2026-11-24 G-14 事故的成因）；
#   ④ 声明 file_delete 的插件，requires_kore 下界同样必须 ≥0.1.1——受控删除自首个含该原语的内核
#      版本（0.1.1）起支持。与 ③ 同型：一个原语一条断言，只查 file_write 会让 file_delete 裸奔
#      （2026-11-24 第二次同型盲区：`site` 的 `vhost-delete` 声明了 file_delete，旧断言却看不见）。
#
# 为什么其它原语**不加**断言（已逐个核实，别凭感觉补）：`writes_host` / `purge_op`（ADR-0023 §3.4
# 账本字段）与 `irreversible`（ADR-0018 一次性 confirm 指纹）都是 0.1.1 边界**之前**就存在的
# root_action 基线协议，24 个插件一律声明 >=0.1.0；给它们造 ≥0.1.1 下界会与版本时间线矛盾，并把
# 4 个声明 `irreversible` 的插件（dns / firewall / ssh-guard / waf）误判 FAIL。将来新增**带版本边界**
# 的原语时，按 ③/④ 的形状各加一条 `X[FILENAME]=1` 检测 + 一条 `cmp(lower, V) < 0` 断言。
.PHONY: version-check

version-check: ## G-14 自洽：内核 VERSION ↔ 24 插件 requires_kore（file_write / file_delete 插件下界 ≥0.1.1）
	@cur=$$(sed -n 's/^VERSION[[:space:]]*?=[[:space:]]*//p' Makefile); \
	mver=$$(sed -n 's/^var version = "\(.*\)"/\1/p' cmd/kored/main.go); \
	echo "[RUN ] version-check（G-14：内核 VERSION=$$cur ↔ 插件 requires_kore）"; \
	if [ -z "$$cur" ]; then echo "[FAIL] Makefile 中读不到 VERSION ?= X.Y.Z"; exit 1; fi; \
	if [ "$$cur" != "$$mver" ]; then \
	  echo "[FAIL] Makefile VERSION=$$cur 与 cmd/kored/main.go 内置默认 $$mver 不一致：go run 与 make build 会报不同版本"; \
	  exit 1; \
	fi; \
	if [ ! -d ../kore-plugin-site ]; then \
	  echo "[SKIP] 未检出 ../kore-plugin-*（$$(pwd)/../）：跨仓 requires_kore 断言跳过，不阻断独立 clone"; \
	  exit 0; \
	fi; \
	awk -v cur="$$cur" ' \
	function cmp(a, b,   x, y, i) { \
	  split(a, x, "."); split(b, y, "."); \
	  for (i = 1; i <= 3; i++) { \
	    if (x[i] + 0 > y[i] + 0) return 1; \
	    if (x[i] + 0 < y[i] + 0) return -1; \
	  } \
	  return 0; \
	} \
	FNR == 1 { order[++n] = FILENAME } \
	match($$0, /"requires_kore"[ \t]*:[ \t]*"[^"]*"/) { \
	  s = substr($$0, RSTART, RLENGTH); sub(/.*"[ \t]*:[ \t]*"/, "", s); sub(/"$$/, "", s); rk[FILENAME] = s; \
	} \
	/"file_write"[ \t]*:/ { fw[FILENAME] = 1 } \
	/"file_delete"[ \t]*:/ { fd[FILENAME] = 1 } \
	END { \
	  bad = 0; fails = 0; \
	  if (n == 0) { print "[FAIL] 没有扫到任何 ../kore-plugin-*/info.json"; exit 1 } \
	  for (i = 1; i <= n; i++) { \
	    f = order[i]; name = f; sub(/.*kore-plugin-/, "", name); sub(/\/info.json$$/, "", name); \
	    r = rk[f]; \
	    if (r == "") { printf "[FAIL] %-24s 缺 requires_kore（G-14 必填）\n", name; bad = 1; fails++; continue } \
	    lower = ""; upper = ""; \
	    if (match(r, />=?[ \t]*[0-9]+\.[0-9]+\.[0-9]+/)) { t = substr(r, RSTART, RLENGTH); gsub(/[>= \t]/, "", t); lower = t } \
	    if (match(r, /<[ \t]*[0-9]+\.[0-9]+\.[0-9]+/)) { t = substr(r, RSTART, RLENGTH); gsub(/[< \t]/, "", t); upper = t } \
	    if (lower == "") { printf "[FAIL] %-24s requires_kore=%s 解析不出下界（需 >=X.Y.Z <A.B.C）\n", name, r; bad = 1; fails++; continue } \
	    verdict = "OK"; \
	    if (cmp(cur, lower) < 0) { printf "[FAIL] %-24s requires_kore=%s 下界高于内核 %s（装上也只会 E_UNSUPPORTED）\n", name, r, cur; bad = 1; fails++; verdict = "FAIL" } \
	    if (upper != "" && cmp(cur, upper) >= 0) { printf "[FAIL] %-24s requires_kore=%s 上界不高于内核 %s（区间已不含当前内核）\n", name, r, cur; bad = 1; fails++; verdict = "FAIL" } \
	    if ((f in fw) && cmp(lower, "0.1.1") < 0) { printf "[FAIL] %-24s 声明 file_write 但下界 %s < 0.1.1（受控写自 0.1.1 起才有内核支持）\n", name, lower; bad = 1; fails++; verdict = "FAIL" } \
	    if ((f in fd) && cmp(lower, "0.1.1") < 0) { printf "[FAIL] %-24s 声明 file_delete 但下界 %s < 0.1.1（受控删除自首个含该原语的内核版本 0.1.1 起支持）\n", name, lower; bad = 1; fails++; verdict = "FAIL" } \
	    if (verdict == "OK") printf "[ OK ] %-24s %-20s%s%s\n", name, r, ((f in fw) ? "  ← file_write" : ""), ((f in fd) ? "  ← file_delete" : ""); \
	    total++; \
	  } \
	  if (bad == 0) { \
	    printf "[ OK ] version-check: 内核 VERSION=%s 覆盖 %d 个插件，全部落在 requires_kore 区间内\n", cur, total; \
	  } else { \
	    printf "[FAIL] version-check: 内核 VERSION=%s 有 %d 项不自洽（%d 个插件已核对）\n", cur, fails, total; \
	  } \
	  exit bad; \
	}' ../kore-plugin-*/info.json

# ── 索引 → 市场页派生一致性（第 16 段·market 子检查，阻断级 · 2026-11-24 接入 kore 侧）──
# 判据本体在索引仓：kore-plugins/scripts/build-market.sh --check —— 只读、逐字节比对
# market/plugins.js 与 index/plugins.json 的期望内容；不一致 exit 1 并列出 market↔index 版本差。
# 为什么 kore 侧要再跑一次：日常反馈的权威入口是本地 make check。只在索引仓自己的 make check / CI
# 上跑，「改了索引没同轮重建市场页」在 kore 仓跑门禁时抓不到，等于判据只在 CI 或手动进索引仓时生效。
# 目录约定与 scripts/*.sh 一致：默认 ../kore-plugins，可用 KORE_PLUGINS_DIR 覆盖（CI / worktree / 测试）。
# 缺失 kore-plugins → SKIP（kore 仓可独立 clone，不阻断）；存在但 market 与索引不一致 → FAIL（阻断）。
KORE_PLUGINS_DIR ?= ../kore-plugins
.PHONY: market-check

market-check: ## 索引→市场页一致性（调用索引仓 build-market.sh --check；kore-plugins 缺失时 SKIP，不一致 FAIL）
	@if [ ! -d "$(KORE_PLUGINS_DIR)" ]; then \
	  echo "[SKIP] 未检出 kore-plugins（$(KORE_PLUGINS_DIR)）：索引→市场页一致性跳过，不阻断独立 clone（可用 KORE_PLUGINS_DIR 指向索引仓）"; \
	  exit 0; \
	fi; \
	if [ ! -f "$(KORE_PLUGINS_DIR)/scripts/build-market.sh" ]; then \
	  echo "[FAIL] $(KORE_PLUGINS_DIR) 存在但缺少 scripts/build-market.sh：不是可用的索引仓（请更新 kore-plugins）"; \
	  exit 1; \
	fi; \
	bash "$(KORE_PLUGINS_DIR)/scripts/build-market.sh" --check

check: ## 聚合门禁（21 段）：docs-check + 明文凭据 + 依赖白名单 + 兼容基线（参数钉死）+ 薄壳边界 + 跨仓库边界 + 口径唯一性 + 台账 + worktree + oss-check + 大小写一致性 + frontend 首屏体积 + 零侵入（ADR-0023）+ 插件仓开源资产（G-26 延伸）+ 插件仓规范（G-17，WARN 级）+ 预设一致性（G-18，阻断级）+ 公钥单一真源（ADR-0025）+ 交叉编译（G-16，五目标真编译，阻断级）+ race 门禁（第 18 段：boundary 面跨仓 + 第 19 段：全仓 -race，均阻断级）+ 嵌套 module pkg/pluginapi 全量 -race（第 21 段，阻断级）
	@fail=0; \
	echo "[RUN ] 1/21 docs-check"; \
	if ! bash scripts/docs-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 2/21 依赖白名单 + 兼容基线【仅参数文本层】G-16：GOAMD64=v1 / GOARM64=v8.0 / GOOS=linux / -buildvcs=false（真编译见 17/21，本段不编译）"; \
	s=0; \
	if ! grep -qE '^GOAMD64[[:space:]]*\?=[[:space:]]*v1$$' Makefile; then echo "[FAIL] GOAMD64 基线漂移（应 GOAMD64 ?= v1）"; s=1; fi; \
	if ! grep -qE '^GOARM64[[:space:]]*\?=[[:space:]]*v8\.0$$' Makefile; then echo "[FAIL] GOARM64 基线漂移（应 GOARM64 ?= v8.0）"; s=1; fi; \
	if ! grep -qE '^BUILDFLAGS[[:space:]]*:=.*-buildvcs=false' Makefile; then echo "[FAIL] BUILDFLAGS 缺少 -buildvcs=false（可复现构建）"; s=1; fi; \
	if ! grep -qE '^[[:space:]]*CGO_ENABLED=0 GOAMD64=' Makefile; then echo "[FAIL] build 目标未显式钉死 GOAMD64 / CGO_ENABLED"; s=1; fi; \
	for tgt in 'GOOS=linux GOARCH=amd64 GOAMD64=' 'GOOS=linux GOARCH=arm64 GOARM64=' 'GOOS=windows GOARCH=amd64 GOAMD64=' 'GOOS=darwin GOARCH=arm64 GOARM64=' 'GOOS=darwin GOARCH=amd64 GOAMD64='; do \
	  if ! grep -qE "^[[:space:]]*CGO_ENABLED=0 $$tgt" Makefile; then echo "[FAIL] cross 缺少目标或基线未钉死: $$tgt"; s=1; fi; \
	done; \
	if [ "$$s" -eq 0 ]; then echo "[OK] 兼容基线通过（构建参数已钉死）"; else fail=1; fi; \
	echo "[INFO] 依赖白名单（第三方 ≤3 个；同仓 module 不计配额，须 replace => ./）"; \
	if ! bash scripts/dep-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 3/21 薄壳边界检查（主壳不含业务逻辑 / 不做同进程动态库插件）"; \
	if [ ! -d ./cmd ] && [ ! -d ./internal ]; then \
	  echo "[N/A] 源码未就绪（cmd/internal 缺失），薄壳边界检查跳过，M1 自动生效"; \
	else \
	  s=0; \
	  if ! bash scripts/thin-shell-check.sh; then s=1; fi; \
	  if [ -f go.mod ] && grep -qE 'gin-gonic|labstack/echo|gofiber|grpc-go|nats-io|go-sqlite3|go-redis|docker/docker|containerd' go.mod; then echo "[FAIL] go.mod 含禁止的 Web 框架/中间件/容器依赖（红线 2/4）"; s=1; fi; \
	  if [ "$$s" -eq 0 ]; then echo "[OK] 薄壳边界通过"; else fail=1; fi; \
	fi; \
	echo ""; \
	echo "[RUN ] 4/21 repo-check（跨仓库边界：本仓库不含插件代码 / 插件 import / 插件索引）"; \
	if ! $(MAKE) --no-print-directory repo-check; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 5/21 canonical-check（口径唯一性：旧预算 / 旧字段 / 幽灵 id 清零）"; \
	if ! bash scripts/canonical-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 6/21 log-check（判断留痕台账：WARN 级，不阻断提交）"; \
	log_out=$$(bash scripts/log-check.sh 2>&1 || true); printf '%s\n' "$$log_out"; \
	log_warn=$$(printf '%s\n' "$$log_out" | grep -c '^\[WARN\]' || true); log_warn=$${log_warn:-0}; \
	if [ "$$log_warn" -gt 0 ]; then echo "[WARN] 台账有 $$log_warn 处缺口（WARN 级，不阻断；里程碑收口时人工判）"; fi; \
	echo ""; \
	echo "[RUN ] 7/21 wt-check（worktree 卫生：WARN 级，不阻断提交）"; \
	wt_out=$$(bash scripts/wt-check.sh 2>&1 || true); printf '%s\n' "$$wt_out"; \
	wt_warn=$$(printf '%s\n' "$$wt_out" | grep -c '^\[WARN\]' || true); wt_warn=$${wt_warn:-0}; \
	if [ "$$wt_warn" -gt 0 ]; then echo "[WARN] worktree 卫生有 $$wt_warn 处残留（WARN 级，不阻断；里程碑收口前必须清空）"; fi; \
	echo ""; \
	echo "[RUN ] 8/21 oss-check（开源资产：MIT LICENSE / 根文档 / CI / 占位符 / 协议头；G-26）"; \
	if ! bash scripts/oss-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 9/21 case-check（大小写一致性：module 路径 / 同目录冲突 / 旧仓库名 / 插件 id / 文档 URL）"; \
	if ! bash scripts/case-check.sh; then fail=1; fi; \
	echo "[RUN ] 10/21 frontend 首屏体积（G-03：≤300 KiB gzip · R4：dist 无 map/.vite/字体，阻断级）"; \
	if ! $(MAKE) --no-print-directory frontend; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 11/21 零侵入门禁（ADR-0023：隔离安装根下系统路径零新增 / 豁免项单列）"; \
	if ! bash scripts/zero-intrusion-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 12/21 secret-check（G-30：docs/ 与 .agents/verify/ 明文凭据扫描）"; \
	if ! bash scripts/secret-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 13/21 插件仓开源资产（G-26 延伸：25 仓九件套 + .github 模板 + CI，见 scripts/plugin-oss-check.sh）"; \
	if ! bash scripts/plugin-oss-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 14/21 store-check（G-17：插件仓三件套 + info.json 必填字段 + id/目录一致 + info/manifest 版本一致 + 本地 dist sha ↔ 索引记录 sha（WARN，DIST_SHA_DIFF）+ README 全文 dist/<id>-<ver>.tar.gz 引用版本 ↔ info.json.version（WARN，README_VERSION_DRIFT，带行号）；WARN 级）"; \
	store_out=$$(bash scripts/store-check.sh 2>&1 || true); printf '%s\n' "$$store_out"; \
	store_fail=$$(printf '%s\n' "$$store_out" | grep -c '^\[FAIL\]' || true); store_fail=$${store_fail:-0}; \
	if [ "$$store_fail" -gt 0 ]; then \
	  echo "[WARN] store-check 有 $$store_fail 处不合规（WARN 级不阻断：判据未放宽，单跑 bash scripts/store-check.sh 为 exit 1；转阻断条件见 QUALITY-GATES §G-17）"; \
	fi; \
	echo ""; \
	echo "[RUN ] 15/21 presets-check（G-18：预设 id / 版本区间可解析 + 常驻 RSS ≤48 MiB + 同时常驻 ≤3 + 包体积；G-20：索引↔仓库 depth_level 一致 + out_of_box×depth_level + 判据① tests/boundary 静态核对后 go test 真跑；阻断级）"; \
	if ! bash scripts/presets-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 16/21 公钥单一真源（ADR-0025：verify.go IndexPublicKeyHex ↔ 索引仓 validate-index.sh PUB_HEX）"; \
	if ! bash scripts/pubkey-sync-check.sh; then fail=1; fi; \
	echo "[RUN ] 16 段·market 索引→市场页派生一致（kore-plugins 缺失时 SKIP，不阻断独立 clone；存在但不一致 FAIL 阻断）"; \
	if ! $(MAKE) --no-print-directory market-check; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 17/21 交叉编译（G-16 阻断级：五目标「全仓 go build ./...」+ kored 五产物真编译，windows/amd64 + darwin/arm64 为 G-16 明文判据；判据只验证文本=漏检；go build 不含 _test.go，测试包见 make cross-vet）"; \
	if ! $(MAKE) --no-print-directory cross-build; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 18/21 race 门禁（-race 只跑 ./tests/boundary/：跨仓接线静态核对 + 有边界用例的仓 make race 真跑；阻断级）"; \
	if ! bash scripts/race-gate-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 19/21 全仓 -race（阻断级：GOWORK=off CGO_ENABLED=1 go test -race -count=1 ./... 固定面必绿；kore 本仓无 tests/boundary → 第 18 段对本仓恒 SKIP，本段补位；实测约 52s，cmd/kored 主导）"; \
	if ! bash scripts/race-full-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 20/21 usability-check（G-33 产品可用性：A1 写操作零参数 in-process 真跑 + A2 presets + A3 invalid 文案 + A4 内部术语 + A5 空状态/跳转 + A6 一级菜单 ≤10 + A7 主流程 ≤3 点击；WARN 级：存量待裁决清单见 scripts/usability-pending.txt）"; \
	usability_out=$$(bash scripts/usability-check.sh 2>&1 || true); printf '%s\n' "$$usability_out"; \
	usability_fail=$$(printf '%s\n' "$$usability_out" | grep -c '^\[FAIL\]' || true); usability_fail=$${usability_fail:-0}; \
	if [ "$$usability_fail" -gt 0 ]; then \
	  echo "[WARN] usability-check 有 $$usability_fail 处新违规（WARN 级不阻断：判据未放宽，单跑 bash scripts/usability-check.sh 为 exit 1；转阻断条件见 .agents/QUALITY-GATES.md §G-33）"; \
	fi; \
	echo ""; \
	echo "[RUN ] 21/21 嵌套 module pkg/pluginapi 全量 -race（阻断级：pkg/pluginapi 自带 go.mod，根 ./... 不跨 module → 第 17/19 段不覆盖它；cd pkg/pluginapi && GOWORK=off CGO_ENABLED=1 go test -race -count=1 ./...）"; \
	if ! $(MAKE) --no-print-directory pluginapi-race; then fail=1; fi; \
	echo ""; \
	if [ "$$fail" -ne 0 ]; then echo "[FAIL] 门禁未通过 — 见上方明细"; exit 1; fi; \
	echo "[OK] 门禁全部通过"

install: build ## 安装二进制 + systemd unit（写安装目录外：ADR-0023 豁免 #1/#4）
	@echo "[WARN] make install 会写入安装目录外（ADR-0023 §3.5 豁免）："
	@echo "       #1 systemd unit  $(UNITDIR)/$(UNITNAME) + enable 软链"
	@echo "       #4 二进制        $(BINDIR)/kored"
	@install -d -m 0755 "$(BINDIR)"
	@install -m 0755 "$(BIN)" "$(BINDIR)/kored"
	@echo "[OK] 已安装二进制: $(BINDIR)/kored"
	@bash scripts/install-service.sh "$(BINDIR)/kored" "$(PREFIX)" "$(UNITDIR)" "$(UNITNAME)"

uninstall: ## 卸载链（ADR-0023 阶段 B）：unit / kore-* 用户 / 账本清单（ARGS="--dry-run" 先看计划）
	@echo "[INFO] 调 kored uninstall（PREFIX=$(PREFIX)；ARGS=$(ARGS)）"
	@if [ -x "$(BINDIR)/kored" ]; then \
	  KORE_HOME="$(PREFIX)" "$(BINDIR)/kored" uninstall $(ARGS); \
	else \
	  echo "[INFO] 未找到 $(BINDIR)/kored，改用 go run（KORE_HOME=$(PREFIX)）"; \
	  KORE_HOME="$(PREFIX)" $(GO) run $(CMD) uninstall $(ARGS); \
	fi

clean: ## 清理构建产物（bin/ 与 web/dist）
	@rm -rf bin web/dist
	@echo "[OK] 已清理: bin/ web/dist"

fmt: ## gofmt 格式化（源码未就绪时 SKIP）
	@dirs=""; \
	if [ -d ./cmd ]; then dirs="$$dirs ./cmd"; fi; \
	if [ -d ./internal ]; then dirs="$$dirs ./internal"; fi; \
	if [ -z "$$dirs" ]; then echo "[SKIP] 源码未就绪（cmd/internal 缺失），M1 实现"; exit 0; fi; \
	gofmt -l -w $$dirs; \
	echo "[OK] gofmt 完成"
