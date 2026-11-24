# ── race 门禁（唯一真源：kore/scripts/plugin-templates/plugin-repo/Makefile.race.mk）──
# 由 kore/scripts/race-gate-sync.sh 渲染进各插件仓 Makefile；改这里，不要手改 24 份。
#
# 为什么只对 ./tests/boundary/ 加 -race：
#   并发断言集中在边界用例里；-race 通常让测试慢 2–10 倍，全仓 go test -race 会把
#   每个仓的 make check 拖长数倍，日常反馈不可接受。边界面是"数据竞争必须被抓"的面。
# 判据不放宽：race 段与 check 同属阻断级（失败即 make check 失败），无 tests/boundary
#   时只 SKIP 不假装通过；新增边界用例后无需再改 Makefile，race 自动生效。
# 环境：-race 需要 cgo（linux/amd64 用 gcc）——CI 的 ubuntu-latest 自带；本地缺编译器时
#   报错原文会直接暴露（"-race requires cgo"），不静默降级。
RACE_PKG ?= ./tests/boundary/...

race: ## -race 跑并发边界用例（无 tests/boundary 时 SKIP）
	@if [ ! -d tests/boundary ]; then echo "[SKIP] 无 tests/boundary：race 门禁无目标（新增边界用例后自动生效）"; exit 0; fi; \
	echo "[RUN ] race: CGO_ENABLED=1 go test -race -count=1 -timeout 300s $(RACE_PKG)"; \
	CGO_ENABLED=1 GOWORK=off go test -race -count=1 -timeout 300s $(RACE_PKG)
