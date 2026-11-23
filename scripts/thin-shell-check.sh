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

# ---- 3) 业务域词（词首匹配）----
NOUN_RE='(^|[^[:alnum:]_])(backup|site|monitor|cron|ssl|database|mysql|nginx|docker)'
# 精确词根豁免（2026-11-23，ADR-0028 一期）：internal/core/filewrite 是**通用受控写
# 原语**（与 privilege 同层：内核代理写一个受限文件），不含任何 sshd/nginx 领域知识；
# 该包里 Backup 指「写前备份原文件」这一通用保护动作，不是 backup 插件的业务域。
# 只对**该包**把 backup 词根替换为中性占位，其它业务词与其它目录的匹配强度一字不动。
NOUN_SCAN=$(printf '%s\n' "$CODE" | awk '
/^\.\/internal\/core\/filewrite\// {
  gsub(/Backup/, "CopySelf")
  gsub(/backup/, "copyself")
}
{ print }')
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
VERB_SCAN=$(printf '%s\n' "$CODE" | sed 's/--no-create-home//g')
VERB_RE='(^|[^[:alnum:]_])(create|restart|deploy)([^[:alnum:]_]|$)'
VERB_HITS=$(printf '%s\n' "$VERB_SCAN" | grep -iE -- "$VERB_RE" || true)
if [ -z "$VERB_HITS" ]; then
  ok "业务动作词（整词匹配，注释已剥离）：0 命中（create/restart/deploy）"
else
  bad "可执行代码出现业务动作词（整词匹配）"
  printf '%s\n' "$VERB_HITS" | head -10 | while IFS= read -r l; do detail "$l"; done
fi

printf '\n'
printf 'thin-shell-check: %d pass, %d fail（扫描 %d 个可执行 .go 文件）\n' "$PASS" "$FAIL" "${#FILES[@]}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
