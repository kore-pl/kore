#!/usr/bin/env bash
# kore 文档门禁（M0）— 校验：必需文件 / 元信息 / 相对链接 / 占位词 / 行数 / 关键口径
# 用法: bash scripts/docs-check.sh [--self-test]
#   --self-test 只跑链接分类的正反用例（不造临时资产、不读仓库文档）
# 退出码: 存在 FAIL → 1；仅 WARN → 0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 跨仓相对链接豁免（与 market-check「kore-plugins 缺失 SKIP」口径一致）：
# docs/ 与 .agents/ 里的链接可达性判据只对本仓负责。若一条相对链接解析后落在兄弟仓
# （kore-plugin-* / kore-plugins）目录内，且目标不存在（独立 clone 未检出该仓），
# 则豁免为 [SKIP]，不阻断；目标存在时照常判可达。指向本仓内的相对链接一律硬判据。
cross_repo_link() {
  # $1=链接所在目录（相对 ROOT），$2=target；解析为相对 ROOT 的路径后判定。
  # 只认「跳出本仓（../ 开头）且第一段是兄弟仓名」，避免受 clone 目录名影响。
  local dir="$1" target="$2" rel
  rel=$(realpath -m --relative-to="$ROOT" -- "$dir/$target")
  case "$rel" in
    ../kore-plugins|../kore-plugins/*|../kore-plugin-*) return 0 ;;
  esac
  return 1
}

# --self-test：只测链接分类函数，不读仓库文档；退出即结束（不造持久资产）。
if [ "${1:-}" = "--self-test" ]; then
  st_fail=0
  check() { # $1=期望(0=兄弟仓/1=本仓) $2=dir $3=target $4=说明
    local want="$1" dir="$2" target="$3" what="$4" got
    if cross_repo_link "$dir" "$target"; then got=0; else got=1; fi
    if [ "$got" = "$want" ]; then
      printf '[PASS] self-test %s\n' "$what"
    else
      printf '[FAIL] self-test %s（期望 %s，实际 %s）\n' "$what" "$want" "$got"
      st_fail=$((st_fail + 1))
    fi
  }
  check 0 "docs/DECISIONS" "../../../kore-plugin-dns/README.md" "兄弟仓链接(kore-plugin-*)被识别"
  check 0 ".agents/verify" "../../../kore-plugins/scripts/sign-index.sh" "兄弟仓链接(kore-plugins)被识别"
  check 1 "docs/DECISIONS" "../../QUICKSTART.md" "本仓内链接不被误判为跨仓"
  check 1 "docs" "CORE.md" "本仓子目录链接不被误判为跨仓"
  # 误伤边界：文件名里含 kore-plugin- 但不是兄弟仓根目录，仍按本仓判据。
  check 1 "docs" "my-kore-plugin-notes.md" "文件名含 kore-plugin 不误判"
  if [ "$st_fail" -gt 0 ]; then
    printf 'docs-check self-test: %d FAIL\n' "$st_fail"
    exit 1
  fi
  printf 'docs-check self-test: 5 pass, 0 fail\n'
  exit 0
fi

PASS=0
WARN=0
FAIL=0

pass()    { PASS=$((PASS + 1));   printf '[PASS] %s\n' "$*"; }
warn()    { WARN=$((WARN + 1));   printf '[WARN] %s\n' "$*"; }
failed()  { FAIL=$((FAIL + 1));   printf '[FAIL] %s\n' "$*"; }
DETAILS=()
detail()  { DETAILS+=("$*"); }
flush_details() {
  local d
  if [ "${#DETAILS[@]}" -gt 0 ]; then
    for d in "${DETAILS[@]}"; do
      printf '       %s\n' "$d"
    done
    DETAILS=()
  fi
}
section() { printf '\n-- %s --\n' "$*"; }

# 文档范围：docs/ 与 .agents/ 下全部 *.md（递归），排除 .agents/verify/（冻结证据）
DOC_FILES=()
EVIDENCE_FILES=()
while IFS= read -r f; do
  if [ -n "$f" ]; then
    DOC_FILES+=("$f")
  fi
done < <(find docs .agents -type f -name '*.md' 2>/dev/null | grep -v '^\.agents/verify/' | sort || true)
while IFS= read -r f; do
  if [ -n "$f" ]; then
    EVIDENCE_FILES+=("$f")
  fi
done < <(find .agents/verify -type f -name '*.md' 2>/dev/null | sort || true)

# 链接检查范围 = 文档 + 证据（证据里引用 docs/... 也必须可达）
LINK_FILES=()
for f in "${DOC_FILES[@]+"${DOC_FILES[@]}"}" "${EVIDENCE_FILES[@]+"${EVIDENCE_FILES[@]}"}"; do
  LINK_FILES+=("$f")
done

printf '[INFO] 已排除 .agents/verify/（冻结证据，按证据规范而非文档模板）\n'
printf '[INFO] 文档计数: %d 份（docs/**.md + .agents/**.md，不含 verify）· 证据计数: %d 份（.agents/verify/，仅参与链接检查）\n' \
  "${#DOC_FILES[@]}" "${#EVIDENCE_FILES[@]}"

# 提取 markdown 链接（跳过 ``` / ~~~ 围栏代码块），输出形如 [text](target) 或 ![alt](target)
links_of() {
  awk '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    { print }
  ' "$1" | grep -oE '!?\[[^]]*\]\([^)]*\)' || true
}

# ---------------------------------------------------------------- 1/6 必需文件
section "1/6 必需文件"
REQUIRED=(
  docs/VISION.md
  docs/ARCHITECTURE.md
  docs/CORE.md
  docs/PLUGIN-PROTOCOL.md
  docs/RESOURCE-MODEL.md
  docs/DATA-MODEL.md
  docs/FRONTEND.md
  docs/SECURITY.md
  docs/ROADMAP.md
  docs/PLAN.md
  docs/MILESTONE-M0.md
  docs/GLOSSARY.md
  AGENTS.md
  README.md
  .agents/ROLES.md
  .agents/WORKFLOW.md
)
MISSING=()
for p in "${REQUIRED[@]}"; do
  if [ ! -e "$p" ]; then
    MISSING+=("$p")
  fi
done
DEC_COUNT=0
if [ -d docs/DECISIONS ]; then
  DEC_COUNT=$(find docs/DECISIONS -maxdepth 1 -type f -name '*.md' | wc -l)
fi
if [ "${#MISSING[@]}" -eq 0 ] && [ "$DEC_COUNT" -ge 6 ]; then
  pass "必需文件齐全：16 项 + docs/DECISIONS ${DEC_COUNT} 篇"
else
  failed "必需文件不齐：缺文件 ${#MISSING[@]} 项，DECISIONS ${DEC_COUNT}/6 篇"
  if [ "${#MISSING[@]}" -gt 0 ]; then
    for m in "${MISSING[@]}"; do
      detail "缺失: $m"
    done
  fi
  if [ "$DEC_COUNT" -lt 6 ]; then
    detail "缺失: docs/DECISIONS/ 至少 6 篇 .md（当前 ${DEC_COUNT}）"
  fi
fi
flush_details

# ---------------------------------------------------------------- 2/6 元信息
# 契约：每份文档前 5 行含 `> 状态: ...` 与 `里程碑: M0`–`M5` 或 `R<序号>`（跨里程碑文档必须能过，不硬编码 M0；每新增里程碑 / R 轮次须同轮放宽此允许集）
section "2/6 元信息（前 5 行含 '> 状态:' 且含 '里程碑: M0–M5 / R<序号>'）"
if [ "${#DOC_FILES[@]}" -eq 0 ]; then
  failed "未发现待校验文档（docs/ 与 .agents/ 下均无 .md）"
else
  META_BAD=0
  for f in "${DOC_FILES[@]}"; do
    head5=$(head -n 5 "$f" || true)
    if ! printf '%s\n' "$head5" | grep -qF '> 状态:'; then
      detail "元信息缺失(状态): $f"
      META_BAD=$((META_BAD + 1))
    fi
    ms=""
    if [[ "$head5" =~ 里程碑:[[:space:]]*((M|R)[0-9]+) ]]; then
      ms="${BASH_REMATCH[1]}"
    fi
    if [ -z "$ms" ]; then
      detail "元信息缺失(里程碑): $f"
      META_BAD=$((META_BAD + 1))
    elif ! [[ "$ms" =~ ^(M[0-5]|R[0-9]+)$ ]]; then
      detail "元信息里程碑非法: $f（读到 '${ms}'，允许 M0–M5 或 R<序号>）"
      META_BAD=$((META_BAD + 1))
    fi
  done
  if [ "$META_BAD" -eq 0 ]; then
    pass "全部 ${#DOC_FILES[@]} 份文档元信息合规"
  else
    failed "元信息不合规 ${META_BAD} 处（文件见上方明细）"
  fi
fi
flush_details

# ---------------------------------------------------------------- 3/6 相对链接
section "3/6 相对链接可达性（文档 + 冻结证据）"
if [ "${#LINK_FILES[@]}" -eq 0 ]; then
  failed "未发现待校验文档或证据，相对链接检查无对象"
else
  LINK_CHECKED=0
  LINK_SKIPPED=0
  LINK_BROKEN=0
  for f in "${LINK_FILES[@]}"; do
    dir=$(dirname "$f")
    while IFS= read -r raw; do
      if [ -z "$raw" ]; then
        continue
      fi
      case "$raw" in
        '!'*) continue ;;  # 图片不校验
      esac
      target=$(printf '%s\n' "$raw" | sed -E 's/^\[[^]]*\]\(//; s/\)$//')
      target=$(printf '%s\n' "$target" | sed -E 's/[[:space:]]+"[^"]*"$//')
      target=$(printf '%s\n' "$target" | sed -E 's/^<//; s/>$//')
      target=${target%%#*}
      case "$target" in
        ''|'#'*|http://*|https://*|mailto:*|tel:*|data:*|file:*|/*) continue ;;
      esac
      LINK_CHECKED=$((LINK_CHECKED + 1))
      if [ ! -e "${dir}/${target}" ]; then
        # 兄弟仓缺失（独立 clone 未检出）= SKIP，口径同 market-check；本仓内断链仍 FAIL。
        if cross_repo_link "$dir" "$target"; then
          detail "[SKIP] 兄弟仓未检出: ${f} → ${target}（独立 clone 豁免）"
          LINK_SKIPPED=$((LINK_SKIPPED + 1))
        else
          detail "断链: ${f} → ${target}"
          LINK_BROKEN=$((LINK_BROKEN + 1))
        fi
      fi
    done < <(links_of "$f")
  done
  if [ "$LINK_BROKEN" -eq 0 ]; then
    pass "检查 ${LINK_CHECKED} 条相对链接，全部可达（其中 ${LINK_SKIPPED} 条兄弟仓缺失豁免 SKIP）"
  else
    failed "相对链接断链 ${LINK_BROKEN} 条（共检查 ${LINK_CHECKED} 条；兄弟仓缺失豁免 ${LINK_SKIPPED} 条）"
  fi
fi
flush_details

# ---------------------------------------------------------------- 4/6 占位词
section "4/6 占位词（每份文档 TODO / 待补充 / 待定 合计 ≤ 2 次）"
if [ "${#DOC_FILES[@]}" -eq 0 ]; then
  warn "未发现待校验文档，占位词检查跳过"
else
  PH_OVER=0
  for f in "${DOC_FILES[@]}"; do
    n=$( { grep -oE 'TODO|待补充|待定' "$f" || true; } | wc -l)
    if [ "$n" -gt 2 ]; then
      detail "占位词超限: ${f}:${n}"
      PH_OVER=$((PH_OVER + 1))
    fi
  done
  if [ "$PH_OVER" -eq 0 ]; then
    pass "占位词密度合规（全部 ≤ 2 次）"
  else
    warn "占位词超限 ${PH_OVER} 份文档（WARN，不阻断）"
  fi
fi
flush_details

# ---------------------------------------------------------------- 5/6 行数
# 行数豁免清单：逐条登记、必须写理由。判据本身不放宽——豁免只对登记的这一份文件生效，
# 且理由必须回答「为什么不能拆 / 为什么不该注水到下限」。理由为空 = 登记无效，按越界计入 WARN。
# 格式：["<相对仓库根的路径>"]="<下限>:<上限>|<理由>"
declare -A LINES_EXEMPT=(
  ["docs/PLUGIN-PROTOCOL.md"]="100:400|真源类（插件协议 kore.plugin.v1）：§3.1 是 info.json 必填字段的唯一真源（AGENTS.md G-17 与 scripts/store-check.sh 均按节号引用），§4–§17 的帧格式 / 握手 / 状态机 / 错误码 / 事件类型互相引用，拆分会切断跨节不变量；AGENTS.md §7 明文允许真源类（协议/规格/append 型台账）超长"
  ["docs/SIGNING-KEY-SOP.md"]="100:400|下限豁免（SOP 类）：§1–§7 已覆盖生成 / 备份 / 日常重签 / 轮换 / 泄漏应急 / 复核周期 / 机制自测，命令可直接执行；88 行低于 100 下限是信息密度高而非内容缺失，为凑下限加行即注水"
)

section "5/6 行数（docs/*.md 期望 100-400；MILESTONE-M0.md 放宽到 60-400；豁免逐条登记并打印理由）"
if [ ! -d docs ]; then
  warn "docs/ 不存在，行数检查跳过"
else
  LC_OVER=0
  LC_EXEMPT=0
  LC_STALE=0
  for f in docs/*.md; do
    if [ ! -e "$f" ]; then
      continue
    fi
    n=$(wc -l < "$f")
    lo=100
    hi=400
    if [ "$(basename "$f")" = "MILESTONE-M0.md" ]; then
      lo=60
    fi
    if [ -n "${LINES_EXEMPT[$f]:-}" ]; then
      spec="${LINES_EXEMPT[$f]}"
      elo="${spec%%:*}"
      rest="${spec#*:}"
      ehi="${rest%%|*}"
      why="${rest#*|}"
      if [ "$rest" = "$why" ] || [ -z "$why" ]; then
        detail "行数豁免登记无效（缺理由，按越界计）: ${f}:${n}"
        LC_OVER=$((LC_OVER + 1))
        continue
      fi
      printf '[EXEMPT] %s:%s 行（登记区间 %s-%s，文档判据 %s-%s）— 理由: %s\n' \
        "$f" "$n" "$elo" "$ehi" "$lo" "$hi" "$why"
      LC_EXEMPT=$((LC_EXEMPT + 1))
      continue
    fi
    if [ "$n" -lt "$lo" ] || [ "$n" -gt "$hi" ]; then
      detail "行数越界: ${f}:${n}（期望 ${lo}-${hi}）"
      LC_OVER=$((LC_OVER + 1))
    fi
  done
  # 豁免登记指向已删除/改名的文件 = 过期豁免，必须清掉（否则清单会变成噪声）。
  for k in "${!LINES_EXEMPT[@]}"; do
    if [ ! -e "$k" ]; then
      detail "行数豁免登记指向不存在的文件（请删除该条）: ${k}"
      LC_STALE=$((LC_STALE + 1))
    fi
  done
  if [ "$LC_OVER" -eq 0 ] && [ "$LC_STALE" -eq 0 ]; then
    pass "docs/*.md 行数全部落在区间内（${LC_EXEMPT} 份越界已逐条登记豁免）"
  elif [ "$LC_STALE" -gt 0 ]; then
    warn "行数越界 ${LC_OVER} 份 + 过期豁免登记 ${LC_STALE} 条（WARN，不阻断）"
  else
    warn "行数越界 ${LC_OVER} 份（WARN，不阻断）"
  fi
fi
flush_details

# ---------------------------------------------------------------- 6/6 关键口径
section "6/6 关键口径（docs/ 内每项至少 2 个文件命中）"
if [ ! -d docs ]; then
  failed "docs/ 不存在，关键口径无法校验"
else
  KP_BAD=0
  for tok in "8 MiB" "kore.plugin.v1" "/run/kore"; do
    n=$( { grep -rlF --include='*.md' -- "$tok" docs 2>/dev/null || true; } | wc -l)
    if [ "$n" -lt 2 ]; then
      detail "口径覆盖不足: '${tok}' 仅 ${n} 个文件（需 ≥ 2）"
      KP_BAD=$((KP_BAD + 1))
    fi
  done
  if [ "$KP_BAD" -eq 0 ]; then
    pass "关键口径 '8 MiB' / 'kore.plugin.v1' / '/run/kore' 覆盖达标"
  else
    failed "关键口径覆盖不足 ${KP_BAD} 项"
  fi
fi
flush_details

# ---------------------------------------------------------------- 汇总
printf '\n'
printf 'docs-check: %d pass, %d warn, %d fail\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '结果: 门禁未通过（%d FAIL）\n' "$FAIL"
  exit 1
fi
printf '结果: 门禁通过（%d WARN 不阻断）\n' "$WARN"
exit 0
