#!/usr/bin/env bash
# thin-shell-check — 薄壳边界：只扫「可执行代码」，注释先剥离
# 判定（全部零命中才通过）：
#   1) 同进程动态库：import "plugin" / plugin.Open
#   2) 业务包导入："kore/plugins/
#   3) 业务域词（词首匹配，大小写不敏感）：backup|site|monitor|cron|ssl|database|mysql|nginx|docker
#   4) 业务动作词（整词匹配，大小写不敏感）：create|restart|deploy
# 范围：./cmd ./internal 的 *.go，排除 *_test.go 与 testdata/（测试夹具不随二进制发布）
# 注释剥离：行注释 // 与块注释 /* */，且不误伤字符串里的 // 与 /*（含反引号原始字符串）
# 退出码：有 FAIL → 1；通过 → 0
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d ./cmd ] && [ ! -d ./internal ]; then
  printf '[N/A] 源码未就绪（cmd/internal 缺失），薄壳边界检查跳过\n'
  exit 0
fi

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '[OK] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$*"; }
detail(){ printf '       %s\n' "$*"; }

# ---- 注释剥离 + 行号保留：输出 "file:line:可执行代码" ----
STRIP_AWK='
FNR == 1 { in_block = 0; in_str = 0; in_raw = 0 }
{
  line = $0; out = ""; i = 1; n = length(line)
  while (i <= n) {
    c = substr(line, i, 1)
    if (in_block) {
      if (c == "*" && substr(line, i + 1, 1) == "/") { in_block = 0; i += 2 } else { i++ }
      continue
    }
    if (in_raw) {
      out = out c
      if (c == "`") { in_raw = 0 }
      i++
      continue
    }
    if (in_str) {
      out = out c
      if (c == "\\") { i++; out = out substr(line, i, 1) }
      else if (c == "\"") { in_str = 0 }
      i++
      continue
    }
    if (c == "/" && substr(line, i + 1, 1) == "/") { break }
    if (c == "/" && substr(line, i + 1, 1) == "*") { in_block = 1; i += 2; continue }
    if (c == "\"") { in_str = 1 }
    if (c == "`") { in_raw = 1 }
    out = out c
    i++
  }
  print FILENAME ":" FNR ":" out
}
'

FILES=()
while IFS= read -r f; do
  if [ -n "$f" ]; then
    FILES+=("$f")
  fi
done < <(find ./cmd ./internal -type f -name '*.go' ! -name '*_test.go' ! -path '*/testdata/*' 2>/dev/null | sort)

if [ "${#FILES[@]}" -eq 0 ]; then
  printf '[N/A] 未发现可执行 .go 文件（cmd/internal 下无源码）\n'
  exit 0
fi

CODE=$(awk "$STRIP_AWK" "${FILES[@]}" 2>/dev/null || true)

# ---- 1) 同进程动态库 ----
PLUGIN_HITS=$(grep -nE '^[[:space:]]*"plugin"[[:space:]]*(//.*)?$|plugin[.]Open' "${FILES[@]}" 2>/dev/null || true)
if [ -z "$PLUGIN_HITS" ]; then
  ok "无同进程动态库 plugin 使用"
else
  bad "发现同进程动态库 plugin 使用（红线 1）"
  printf '%s\n' "$PLUGIN_HITS" | head -10 | while IFS= read -r l; do detail "$l"; done
fi

# ---- 2) 业务插件包 import ----
PKG_HITS=$(grep -nE '"kore/plugins/' "${FILES[@]}" 2>/dev/null || true)
if [ -z "$PKG_HITS" ]; then
  ok "无 kore/plugins 业务包 import"
else
  bad "主壳 import 业务插件包（红线 3：主壳不含业务逻辑）"
  printf '%s\n' "$PKG_HITS" | head -10 | while IFS= read -r l; do detail "$l"; done
fi

# ---- 已合入特性标识符豁免（词表同步；G-01 红线不放宽）----
# 这些词随已合入特性进入内核的装配/解析层，是通用原语而非插件业务域：
#   - ADR-0057 (ee724d5)：cmd/kored/credential_format.go 的 backup = 凭据文件写前 .legacy 备份；
#   - R23 磁盘分析 (1a618ee)：handlers_disk.go 的 backups/sites = 状态目录枚举名；
#   - R22 webhook (ebf24aa)：webhook.go / webhook_email.go 的 ssl = SMTP TLS 模式枚举；
#   - 站点迁移 (a4a6cd2)：siteimport_parse.go / handlers_site_import.go 的 site/nginx/ssl =
#     通用 nginx 配置只读解析词（不建站、不调插件）；
#   - ADR-0056 (93fd441)：main.go / restart.go / handlers_restart.go / privilege/restart.go
#     的 restart = 内核**自重启**原语（同机、同 uid，不重启插件 unit）。
#   - ADR-0059 §3.5 / U6（M7 83a42ae/960821c）：config 五文件 + serve_boot.go/upgrade.go
#     + market/cleanup.go 的 backup = 旧版本备份份数/磁盘上限**配置项**（backup.keep_count /
#     backup.max_disk_bytes）与其解析字段、校验/审计字符串；内核只做通用"保留 N 份/限额"配置，
#     不含 backup 插件的业务名词表（能力名/动作名由插件仓定义，内核不认识）。
# 边界（fail-closed）：①精确到文件路径；②只替换上列已合入 token；③替换后仍命中的词照常 FAIL；
# ④红线 1/2（plugin / "kore/plugins/" import）对全部文件独立扫描，不在本节豁免范围内；
# ⑤restart 豁免文件出现 kore-plugin-（插件 unit 前缀）单独 FAIL，防止顺带放过插件生命周期。
EXEMPT_AWK='
function neutralize(line,   f) {
  f = line
  sub(/:.*/, "", f)
  if (f == "./cmd/kored/credential_format.go") {
    gsub(/backups/, "archives", line); gsub(/backup/, "archive", line)
  }
  if (f == "./internal/core/httpapi/handlers_disk.go") {
    gsub(/backups/, "dirs", line); gsub(/backup/, "dir", line)
    gsub(/sites/, "dirs", line); gsub(/site/, "dir", line)
  }
  if (f == "./internal/core/httpapi/webhook.go" || f == "./internal/core/httpapi/webhook_email.go") {
    gsub(/SSL/, "TLS", line); gsub(/Ssl/, "Tls", line); gsub(/ssl/, "tls", line)
  }
  if (f == "./internal/core/httpapi/siteimport_parse.go" || f == "./internal/core/httpapi/handlers_site_import.go") {
    gsub(/Sites/, "Dirs", line); gsub(/sites/, "dirs", line)
    gsub(/Site/, "Conf", line); gsub(/site/, "conf", line)
    gsub(/Nginx/, "Httpd", line); gsub(/nginx/, "httpd", line)
    gsub(/SSL/, "TLS", line); gsub(/Ssl/, "Tls", line); gsub(/ssl/, "tls", line)
  }
  if (f == "./cmd/kored/main.go" || f == "./cmd/kored/restart.go" ||
      f == "./internal/core/httpapi/handlers_restart.go" || f == "./internal/core/privilege/restart.go") {
    gsub(/RESTART/, "RELAUNCH", line); gsub(/Restart/, "Relaunch", line); gsub(/restart/, "relaunch", line)
  }
  # ADR-0059 §3.5 / U6：backup.* 是内核通用旧版本保留配置项（非 backup 插件业务域）。
  # 以下 8 个文件只中性化 backup 词根（含错误/审计字符串里的词），不动其它业务词；
  # 若这些文件将来出现 backup 插件业务名词表（能力名/动作名），仍按词表原样 FAIL。
  if (f == "./cmd/kored/serve_boot.go" || f == "./cmd/kored/upgrade.go" ||
      f == "./internal/core/config/parse.go" || f == "./internal/core/config/parse_nested.go" ||
      f == "./internal/core/config/reload.go" || f == "./internal/core/config/types.go" ||
      f == "./internal/core/config/validate.go" || f == "./internal/core/market/cleanup.go") {
    gsub(/BACKUP/, "KEEPVER", line); gsub(/Backup/, "Keepver", line); gsub(/backup/, "keepver", line)
  }
  return line
}
'

# ---- 3) 业务域词（词首匹配）----
NOUN_RE='(^|[^[:alnum:]_])(backup|site|monitor|cron|ssl|database|mysql|nginx|docker)'
# 精确词根豁免（2026-11-23，ADR-0028 一期）：internal/core/filewrite 是**通用受控写
# 原语**（与 privilege 同层：内核代理写一个受限文件），不含任何 sshd/nginx 领域知识；
# 该包里 Backup 指「写前备份原文件」这一通用保护动作，不是 backup 插件的业务域。
# 只对**该包**把 backup 词根替换为中性占位，其它业务词与其它目录的匹配强度一字不动。
NOUN_RULES='
{
  line = neutralize($0)
  if (line ~ /^\.\/internal\/core\/filewrite\//) {
    gsub(/Backup/, "CopySelf", line)
    gsub(/backup/, "copyself", line)
  }
  print line
}'
NOUN_SCAN=$(printf '%s\n' "$CODE" | awk "${EXEMPT_AWK}${NOUN_RULES}")
NOUN_HITS=$(printf '%s\n' "$NOUN_SCAN" | grep -iE -- "$NOUN_RE" || true)
if [ -z "$NOUN_HITS" ]; then
  ok "业务域词（词首匹配，注释已剥离）：0 命中（backup/site/monitor/cron/ssl/database/mysql/nginx/docker）"
else
  bad "可执行代码出现业务域词（词首匹配）"
  printf '%s\n' "$NOUN_HITS" | head -10 | while IFS= read -r l; do detail "$l"; done
fi

# ---- 4) 业务动作词（整词匹配）----
# 精确字面量豁免：useradd 的系统账户参数名 --no-create-home 里含 "create"，
# 但它是工具参数名、不是业务动词。只把这个完整 token 从待匹配文本里摘掉；
# create|restart|deploy 的整词匹配强度与其它文本一字不动。
#
# 精确 token 豁免（2026-11-23，依据：.agents/LOG/DECISIONS.md 2026-11-23 条
# 「thin-shell restart 精确豁免（自升级/自卸载两文件）」；沿用 ADR-0028 对 filewrite
# 的 Backup 先例，但粒度更严）：内核升级后必须重启的是**自己**的 unit，
# 属内核生命周期原语（与 privilege 同层），不是插件的业务动作。豁免边界：
#   1) 文件：只认 cmd/kored/upgrade.go 与 internal/core/privilege/systemd.go 两个精确路径；
#   2) 词：只把下列**已知自管理 token**换成中性占位，不做整文件 restart→relaunch 替换；
#      替换后仍残留的 restart 会照常被 VERB_RE 判 FAIL（fail-closed，不是整文件放行）；
#   3) 交叉约束：这两个文件出现 `kore-plugin-`（插件 unit 前缀）即单独 FAIL——内核自管理
#      文件不得承载插件生命周期，restart 豁免不能顺带放过「重启某个插件的 unit」。
# 因此将来在这些豁免文件里新增任何非自管理 restart 用法，门禁仍会 FAIL 并强制复核。
# ADR-0056 (93fd441) 自重启四文件沿用同一边界（精确路径 + 整 token 中性化 + 插件 unit
# 交叉拦截），词表同步不改变 G-01 红线本身。
SELF_MGMT_FILE_RE='^\.\/(cmd\/kored\/upgrade\.go|internal\/core\/privilege\/systemd\.go|cmd\/kored\/main\.go|cmd\/kored\/restart\.go|internal\/core\/httpapi\/handlers_restart\.go|internal\/core\/privilege\/restart\.go):'
VERB_RULES='
{
  line = neutralize($0)
  if (line ~ /^\.\/cmd\/kored\/upgrade\.go:/) {
    gsub(/submitUpgradeRestart/, "submitUpgradeRelaunch", line)
    gsub(/RestartUnitNoBlock/, "RelaunchUnitNoBlock", line)
    gsub(/noRestart/, "noRelaunch", line)
    gsub(/--no-restart/, "--no-relaunch", line)
    gsub(/"no-restart"/, "\"no-relaunch\"", line)
    gsub(/deps\.restart/, "deps.relaunch", line)
    gsub(/restart[[:space:]]+func\(/, "relaunch func(", line)
    gsub(/restart:/, "relaunch:", line)
    gsub(/systemctl --no-block restart/, "systemctl --no-block relaunch", line)
    gsub(/systemctl restart/, "systemctl relaunch", line)
  }
  if (line ~ /^\.\/internal\/core\/privilege\/systemd\.go:/) {
    gsub(/BuildRestartArgv/, "BuildRelaunchArgv", line)
    gsub(/RestartUnitNoBlock/, "RelaunchUnitNoBlock", line)
    gsub(/"restart"/, "\"relaunch\"", line)
  }
  print line
}'
VERB_SCAN=$(printf '%s\n' "$CODE" | sed 's/--no-create-home//g' | awk "${EXEMPT_AWK}${VERB_RULES}")
VERB_RE='(^|[^[:alnum:]_])(create|restart|deploy)([^[:alnum:]_]|$)'
VERB_HITS=$(printf '%s\n' "$VERB_SCAN" | grep -iE -- "$VERB_RE" || true)
# 用未中性化的 CODE 判定：中性化会把 restart.go 改成 relaunch.go，路径正则将不再匹配。
PLUGIN_UNIT_HITS=$(printf '%s\n' "$CODE" | grep -E -- "$SELF_MGMT_FILE_RE" | grep -E 'kore-plugin-' || true)
if [ -z "$VERB_HITS" ] && [ -z "$PLUGIN_UNIT_HITS" ]; then
  ok "业务动作词（整词匹配，注释已剥离）：0 命中（create/restart/deploy）"
else
  if [ -n "$VERB_HITS" ]; then
    bad "可执行代码出现业务动作词（整词匹配；豁免只覆盖已合入特性的精确文件/token）"
    printf '%s\n' "$VERB_HITS" | head -10 | while IFS= read -r l; do detail "$l"; done
  fi
  if [ -n "$PLUGIN_UNIT_HITS" ]; then
    bad "自重启豁免文件出现插件 unit 前缀（kore-plugin-）：豁免只覆盖内核自重启，不得承载插件生命周期"
    printf '%s\n' "$PLUGIN_UNIT_HITS" | head -10 | while IFS= read -r l; do detail "$l"; done
  fi
fi

printf '\n'
printf 'thin-shell-check: %d pass, %d fail（扫描 %d 个可执行 .go 文件）\n' "$PASS" "$FAIL" "${#FILES[@]}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
