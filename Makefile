# kore — 极简内核驱动 · 插件定义能力 · 资源零侵占
# M0 骨架构建入口：只有骨架与门禁，无业务代码。
# 契约：主壳空载 RSS ≤ 8 MiB（目标 5–6；默认 GOGC=100 + GOMEMLIMIT=6MiB，另跑 GOGC 双档对照）· 常驻插件单 ≤ 12 MiB / 合计 ≤ 24 MiB · 单二进制 ≤ 25 MiB · 前端首屏 ≤ 300 KiB gzip
# 约定：所有 recipe 必须 tab 缩进；输出统一 [OK]/[SKIP]/[N/A]/[FAIL] 前缀。

# ── 兼容性基线（ADR-0009 落地 · G-16）──
# GOAMD64=v1：x86-64 的 SSE2 基线，2003 年后量产的 CPU 全兼容；显式钉死、不继承构建机的 GOAMD64。
#   kore 是薄壳调度内核，无 SIMD 热点，v2/v3 的指令级收益可忽略，换的是"任何 amd64 机器都能跑"。
# GOARM64=v8.0：arm64 基线（Go 1.21+），不要求 ARMv9 特性。
# CGO_ENABLED=0：纯静态单二进制，不耦合 glibc 版本，RHEL8 / Alpine(musl) / 各 LTS 同一份产物可跑（Tier A）。
# -buildvcs=false：不把构建机 git 状态（commit / 脏标记）编进二进制，保证可复现。
# 五目标矩阵（ADR-0009/0010）：linux/amd64 · linux/arm64 · windows/amd64 · darwin/arm64 · darwin/amd64。
#   Linux 为 Tier A；Windows 10 1809+ / macOS 12+ 为 Tier B（降级支持，隔离与限额降级）。
# 产物：make build → bin/kored（本机）；make cross → bin/kored-<os>-<arch>[.exe]；核对见 make compat-info。

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

APP       ?= kored
VERSION   ?= 0.1.0
CMD       ?= ./cmd/kored
BIN       ?= ./bin/kored
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

.PHONY: help build cross compat-info vet test web-dist frontend mem idle budget-check docs-check repo-check canonical-check log-check wt-check oss-check case-check check clean fmt

help: ## 显示本帮助（默认目标）
	@echo "$(APP) $(VERSION) — 极简内核驱动 · 插件定义能力 · 资源零侵占"
	@echo ""
	@echo "用法: make <target>"
	@echo ""
	@awk 'BEGIN { FS = ":.*##" } /^[a-zA-Z_-]+:.*##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# web-dist 保证 embed 需要的 web/dist 主壳产物存在：web/dist 被 .gitignore 忽略，
# 干净检出直接 make build / vet / test 会因 //go:embed 找不到文件而失败（实测 exit 2）。
# 十二个文件 = 首屏三件套 + 布局壳 shell.js + 八个视图模块
# （store/files/sites/tasks/monitor/settings/terminal/db）。
# 只在缺失或源更新时拷贝，不删目录、不跑体积门禁，开销为几次 stat。
WEB_SRC_FILES := index.html app.js style.css shell.js store.js files.js sites.js tasks.js monitor.js settings.js terminal.js db.js

web-dist:
	@mkdir -p web/dist; \
	for f in $(WEB_SRC_FILES); do \
	  if [ ! -f "web/$$f" ]; then continue; fi; \
	  if [ ! -f "web/dist/$$f" ] || [ "web/$$f" -nt "web/dist/$$f" ]; then cp "web/$$f" "web/dist/$$f"; fi; \
	done

build: web-dist ## 构建主壳二进制（本机 GOOS/GOARCH；cmd/kored 未就绪时 SKIP）
	@if [ ! -d "$(CMD)" ]; then echo "[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现"; exit 0; fi; \
	mkdir -p $(dir $(BIN)); \
	CGO_ENABLED=0 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o $(BIN) $(CMD); \
	echo "[OK] 构建完成: $(BIN)"

cross: web-dist ## 交叉编译五目标：linux/amd64·linux/arm64·windows/amd64·darwin/arm64·darwin/amd64
	@if [ ! -d "$(CMD)" ]; then echo "[SKIP] cmd/kored 未就绪（M0 阶段正常），M1 实现"; exit 0; fi; \
	mkdir -p $(dir $(BIN)); \
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-linux-amd64 $(CMD); \
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOARM64=$(GOARM64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-linux-arm64 $(CMD); \
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-windows-amd64.exe $(CMD); \
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 GOARM64=$(GOARM64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-darwin-arm64 $(CMD); \
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 GOAMD64=$(GOAMD64) GOFLAGS="$(GOFLAGS)" $(GO) build $(BUILDFLAGS) -ldflags="$(LDFLAGS)" -o ./bin/kored-darwin-amd64 $(CMD); \
	echo "[OK] 交叉产物: linux-amd64 · linux-arm64 · windows-amd64.exe · darwin-arm64 · darwin-amd64"

compat-info: ## 打印构建参数与产物兼容信息（G-16 核对入口）
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
	if [ -d "$(CMD)" ]; then echo "[INFO] 交叉编译冒烟（五目标）:"; $(MAKE) --no-print-directory cross; else echo "[N/A] cmd/kored 未就绪（M0 阶段正常），交叉编译冒烟跳过，M1 起生效"; fi

vet: web-dist ## go vet 静态检查（源码未就绪时 SKIP）
	@if [ ! -f go.mod ] || { [ ! -d ./cmd ] && [ ! -d ./internal ]; }; then echo "[SKIP] 源码未就绪（无 go.mod 或 cmd/internal 缺失），M1 实现"; exit 0; fi; \
	$(GO) vet ./...; \
	echo "[OK] go vet 通过"

test: web-dist ## 运行单元测试（源码未就绪时 SKIP）
	@if [ ! -f go.mod ] || { [ ! -d ./cmd ] && [ ! -d ./internal ]; }; then echo "[SKIP] 源码未就绪（无 go.mod 或 cmd/internal 缺失），M1 实现"; exit 0; fi; \
	$(GO) test -timeout 200s ./...; \
	echo "[OK] go test 通过"

frontend: web-dist ## 构建前端产物并核对首屏体积（M2-D：零依赖静态拷贝 + gzip ≤300 KiB）
	@if [ ! -f web/index.html ] || [ ! -f web/app.js ] || [ ! -f web/style.css ]; then echo "[SKIP] web/ 壳未就绪，M2 实现"; exit 0; fi; \
	for f in $(WEB_SRC_FILES); do \
	  if [ ! -f "web/$$f" ]; then echo "[SKIP] web/$$f 缺失（主壳产物不齐），M2 实现"; exit 0; fi; \
	done; \
	rm -rf web/dist; \
	mkdir -p web/dist; \
	cp $(addprefix web/,$(WEB_SRC_FILES)) web/dist/; \
	echo "[OK] 前端静态产物已打包: web/dist（12 文件，零依赖；首屏 4 件套 + 8 视图模块按需加载）"; \
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
	if [ -d internal ]; then tn=$$( { grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ --include='*.go' 2>/dev/null | grep -v cert_renew || true; } | wc -l); if [ "$$tn" -eq 0 ]; then echo "[OK] 周期性定时器零命中（Ticker/AfterFunc）；NewTimer 属请求级超时，不在此列（须 Stop()，由评审确认）"; pass=$$((pass + 1)); else echo "[FAIL] 周期性定时器 $$tn 处（Ticker/AfterFunc，cert_renew 除外）"; grep -rnE 'time\.NewTicker|time\.AfterFunc' internal/ cmd/ --include='*.go' 2>/dev/null | grep -v cert_renew | head -5 || true; fail=$$((fail + 1)); fi; else echo "[N/A] 源码未就绪（internal/ 缺失），周期性定时器检查跳过"; na=$$((na + 1)); fi; \
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

check: ## 聚合门禁（10 段）：docs-check + 依赖白名单 + 兼容基线 + 薄壳边界 + 跨仓库边界 + 口径唯一性 + 台账 + worktree + oss-check + 大小写一致性 + frontend 首屏体积（G-03 阻断级）
	@fail=0; \
	echo "[RUN ] 1/10 docs-check"; \
	if ! bash scripts/docs-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 2/10 依赖白名单 + 兼容基线（G-16：GOAMD64=v1 / GOARM64=v8.0 / GOOS=linux / -buildvcs=false）"; \
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
	echo "[RUN ] 3/10 薄壳边界检查（主壳不含业务逻辑 / 不做同进程动态库插件）"; \
	if [ ! -d ./cmd ] && [ ! -d ./internal ]; then \
	  echo "[N/A] 源码未就绪（cmd/internal 缺失），薄壳边界检查跳过，M1 自动生效"; \
	else \
	  s=0; \
	  if ! bash scripts/thin-shell-check.sh; then s=1; fi; \
	  if [ -f go.mod ] && grep -qE 'gin-gonic|labstack/echo|gofiber|grpc-go|nats-io|go-sqlite3|go-redis|docker/docker|containerd' go.mod; then echo "[FAIL] go.mod 含禁止的 Web 框架/中间件/容器依赖（红线 2/4）"; s=1; fi; \
	  if [ "$$s" -eq 0 ]; then echo "[OK] 薄壳边界通过"; else fail=1; fi; \
	fi; \
	echo ""; \
	echo "[RUN ] 4/10 repo-check（跨仓库边界：本仓库不含插件代码 / 插件 import / 插件索引）"; \
	if ! $(MAKE) --no-print-directory repo-check; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 5/10 canonical-check（口径唯一性：旧预算 / 旧字段 / 幽灵 id 清零）"; \
	if ! bash scripts/canonical-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 6/10 log-check（判断留痕台账：WARN 级，不阻断提交）"; \
	log_out=$$(bash scripts/log-check.sh 2>&1 || true); printf '%s\n' "$$log_out"; \
	log_warn=$$(printf '%s\n' "$$log_out" | grep -c '^\[WARN\]' || true); log_warn=$${log_warn:-0}; \
	if [ "$$log_warn" -gt 0 ]; then echo "[WARN] 台账有 $$log_warn 处缺口（WARN 级，不阻断；里程碑收口时人工判）"; fi; \
	echo ""; \
	echo "[RUN ] 7/10 wt-check（worktree 卫生：WARN 级，不阻断提交）"; \
	wt_out=$$(bash scripts/wt-check.sh 2>&1 || true); printf '%s\n' "$$wt_out"; \
	wt_warn=$$(printf '%s\n' "$$wt_out" | grep -c '^\[WARN\]' || true); wt_warn=$${wt_warn:-0}; \
	if [ "$$wt_warn" -gt 0 ]; then echo "[WARN] worktree 卫生有 $$wt_warn 处残留（WARN 级，不阻断；里程碑收口前必须清空）"; fi; \
	echo ""; \
	echo "[RUN ] 8/10 oss-check（开源资产：MIT LICENSE / 根文档 / CI / 占位符 / 协议头；G-26）"; \
	if ! bash scripts/oss-check.sh; then fail=1; fi; \
	echo ""; \
	echo "[RUN ] 9/10 case-check（大小写一致性：module 路径 / 同目录冲突 / 旧仓库名 / 插件 id / 文档 URL）"; \
	if ! bash scripts/case-check.sh; then fail=1; fi; \
	echo "[RUN ] 10/10 frontend 首屏体积（G-03：≤300 KiB gzip · R4：dist 无 map/.vite/字体，阻断级）"; \
	if ! $(MAKE) --no-print-directory frontend; then fail=1; fi; \
	echo ""; \
	if [ "$$fail" -ne 0 ]; then echo "[FAIL] 门禁未通过 — 见上方明细"; exit 1; fi; \
	echo "[OK] 门禁全部通过"

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
