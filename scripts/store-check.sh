#!/usr/bin/env bash
# kore 插件仓规范门禁（G-17）
#
# 用法: bash scripts/store-check.sh [repo-dir ...]
#   无参数 = 扫描 ../kore-plugin-*；无兄弟仓时 [SKIP] 并 exit 0。
#
# 逐仓检查（判据来源 G-17 / G-27，不改判据、不为变绿放宽）：
#   1) 三件套：info.json / Makefile 内含 dist 目标 / CHANGELOG.md
#   2) info.json 必填 14 字段（唯一真源 = docs/PLUGIN-PROTOCOL.md §3.1 必填口径）：
#      id name version protocol entry capabilities resources requires_kore triggers
#      + depends_on conflicts scenario_tags size_bytes（G-17 增补）
#      + depth_level（G-20）
#      = 协议 §3.1 的 9 项 ∪ G-17 的 5 项 ∪ G-20 的 depth_level，去重后 14 项。
#      REQ_FIELDS 必须与协议 §3.1 逐字一致；改清单先改协议。
#   2b) 描述类字段四选一：description / title / summary / name
#      （协议 §3.1 的 name 是必填展示名；G-17 与协议顶层 schema 都不要求
#        description，因此四者全缺只报 WARN、不判 FAIL——2026-11-23 对账）
#   3) id 匹配 ^[a-z][a-z0-9-]*$ 且等于目录名后缀 kore-plugin-<id>
#   4) info.json.version == manifest.json.version（manifest 存在时）
#   5) go.mod 的 replace 只拦 `=> ../` 与绝对路径（`=> ./` 允许，G-17 原文）
#   6) 本地 dist sha ↔ 索引记录 sha（WARN 级，只读，2026-11-24 补）
#      对 dist/<id>-<ver>.tar.gz 逐个比对：ver 命中索引账本（plugins.json 当前版本
#      或 versions.lock.json 版本→sha 基线）时，sha256 必须相等；不等只 WARN 并输出
#      `DIST_SHA_DIFF <id> <version> index=<sha> dist=<sha>`，不 FAIL。
#      为什么 WARN 不 FAIL：dist/ 是构建产物、不入库，本地不一致不等于索引错
#      （已发布物与索引自洽才是硬判据，那个归 validate-index.sh）。它的危害是
#      **污染验收核对口径**：round5 就报过 `SHA_DIFF firewall 0.2.3`。
#      为什么比对全部版本而不是只比当前版本：0.2.3 的野产物在版本 bump 到 0.2.6
#      之后仍留在 dist/，只比当前版本会漏掉它——这正是漏洞本体。
#      索引未记录该版本（如 pre-lock 的 0.1.0）/ dist 该版本不存在 → 静默跳过。
#   7) README「发布产物」版本 ↔ info.json.version（WARN 级，只读，2026-11-24 补）
#      只解析「发布产物」那一行里的 `dist/<id>-<semver>.tar.gz`（各仓当前统一形态）；
#      与 info.json.version 不一致时输出
#      `README_VERSION_DRIFT <id> info=<ver> readme=<ver>`，只 WARN 不 FAIL——
#      README 是文档不是制品，漂移不改 dist sha，但它每轮都要人工追：
#      container 在 cf50949 修过一次版本示例，bump 后再次漂移，故收进机制。
#      解析必须可靠、不猜：无「发布产物」段 / 行内无 dist/<id>-<ver>.tar.gz /
#      包名与插件 id 不一致 / 同行出现多个不同版本 → 该仓 [SKIP] 并说明原因。
#
# 失败逐条指名到「仓 + 文件 + 字段」，不做汇总掩盖。
# 不联网、不调用 git、不修改任何文件。退出码: 0 全过；1 有 FAIL；2 参数错误。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 索引侧只读数据源（与 presets-check.sh 的 INDEX_FILE 同名口径）：
#   INDEX_FILE = 签名索引正文（当前版本 + sha，信任根）
#   LOCK_FILE  = 版本→sha 账本（全量历史版本基线）
INDEX_FILE="${INDEX_FILE:-$ROOT/../kore-plugins/index/plugins.json}"
LOCK_FILE="${LOCK_FILE:-$ROOT/../kore-plugins/index/versions.lock.json}"
export INDEX_FILE LOCK_FILE

usage() {
  cat <<'USAGE'
用法: bash scripts/store-check.sh [repo-dir ...]

  无参数    扫描 ../kore-plugin-*
  repo-dir  指定要校验的插件仓目录，可多个
  --help    打印本帮助

环境变量: INDEX_FILE（签名索引正文，默认 ../kore-plugins/index/plugins.json）
          LOCK_FILE （版本→sha 账本，默认 ../kore-plugins/index/versions.lock.json）
          索引不可达时 dist sha 比对打印 [SKIP]，其余判据照跑。

退出码: 0 无 FAIL；1 有 FAIL；2 参数错误。
USAGE
}

REPOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --*) echo "[FAIL] 未知参数: $1" >&2; usage >&2; exit 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

if [ "${#REPOS[@]}" -eq 0 ]; then
  shopt -s nullglob
  for d in "$ROOT"/../kore-plugin-*; do
    if [ -d "$d" ]; then REPOS+=("$d"); fi
  done
  shopt -u nullglob
  if [ "${#REPOS[@]}" -eq 0 ]; then
    echo "[SKIP] 无兄弟插件仓（../kore-plugin-*），G-17 校验跳过"
    exit 0
  fi
fi

# JSON 解析不做 grep 降级：字段级判据靠猜等于没判据。
if ! command -v python3 >/dev/null 2>&1; then
  echo "[FAIL] 需要 python3 解析 info.json / manifest.json（门禁不降级为 grep 猜测）"
  exit 1
fi

python3 - "${REPOS[@]}" <<'PY'
import hashlib
import json
import os
import re
import sys

# 必填字段：唯一真源 = docs/PLUGIN-PROTOCOL.md §3.1「必填口径」
# = 协议 9 项（id name version protocol entry capabilities resources requires_kore triggers）
#   ∪ G-17 的 5 项（depends_on conflicts scenario_tags size_bytes requires_kore）
#   ∪ G-20 的 depth_level，去重后 14 项。description 不在其中。
# 与本清单不一致 = 第四份口径，禁止；改判据先改协议 §3.1。
REQ_FIELDS = [
    # 协议 §3.1 必填 9 项
    "id", "name", "version", "protocol", "entry",
    "capabilities", "resources", "requires_kore", "triggers",
    # G-17 增补 4 项（requires_kore 与上面去重）
    "depends_on", "conflicts", "scenario_tags", "size_bytes",
    # G-20 增补
    "depth_level",
]
# 描述类字段四选一即可（name 是协议 §3.1 的必填展示名，等价承担「一句话说明」；
# title / summary 为向前兼容的等价命名）。全缺只 WARN，不 FAIL。
DESC_FIELDS = ("description", "title", "summary", "name")
ID_RE = re.compile(r"^[a-z][a-z0-9-]*$")
DIST_RE = re.compile(r"^dist\s*:", re.M)
PREFIX = "kore-plugin-"
# README「发布产物」段解析（只认 `dist/<id>-<semver>.tar.gz` 这一确定形态）
README_MARKER = "发布产物"
README_VER_RE = re.compile(
    r"dist/(?P<pid>[a-z][a-z0-9-]*)-"
    r"(?P<ver>\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)"
    r"\.tar\.gz"
)

n_pass = 0
n_fail = 0
n_warn = 0

# 索引侧只读数据源（不联网、不改索引）：
#   INDEX_PLUGINS = plugins.json 的 id → 当前版本条目（信任根）
#   INDEX_LOCK    = versions.lock.json 的 id → [{version, sha256}]（全量账本）
INDEX_PLUGINS = {}
INDEX_LOCK = {}
index_errors = []

def load_json_quiet(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)

_index_file = os.environ.get("INDEX_FILE", "")
if _index_file and os.path.isfile(_index_file):
    try:
        _raw = load_json_quiet(_index_file)
        for _item in _raw.get("plugins", []) if isinstance(_raw, dict) else []:
            if isinstance(_item, dict) and isinstance(_item.get("id"), str):
                INDEX_PLUGINS[_item["id"]] = _item
    except Exception as exc:  # noqa: BLE001 - 索引读不动要报出来，不能假装比对过
        index_errors.append(f"{_index_file}: {exc}")

_lock_file = os.environ.get("LOCK_FILE", "")
if _lock_file and os.path.isfile(_lock_file):
    try:
        _raw = load_json_quiet(_lock_file)
        if isinstance(_raw, dict) and isinstance(_raw.get("plugins"), dict):
            INDEX_LOCK = _raw["plugins"]
    except Exception as exc:  # noqa: BLE001
        index_errors.append(f"{_lock_file}: {exc}")

HAS_INDEX = bool(INDEX_PLUGINS or INDEX_LOCK)

def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)

for raw in sys.argv[1:]:
    repo = os.path.abspath(raw)
    name = os.path.basename(repo)

    if not os.path.isdir(repo):
        print(f"[FAIL] {name}: 不是目录: {raw}")
        n_fail += 1
        continue

    problems = []
    warnings = []

    # 1) 三件套
    info_path = os.path.join(repo, "info.json")
    mk_path = os.path.join(repo, "Makefile")
    cl_path = os.path.join(repo, "CHANGELOG.md")

    if not os.path.isfile(info_path):
        problems.append("缺 info.json")
    if not os.path.isfile(mk_path):
        problems.append("缺 Makefile")
    else:
        with open(mk_path, encoding="utf-8", errors="replace") as fh:
            mk_text = fh.read()
        if not DIST_RE.search(mk_text):
            problems.append("Makefile 缺 dist 目标")
    if not os.path.isfile(cl_path):
        problems.append("缺 CHANGELOG.md")

    # 2)~4) info.json 必填字段 / id / 版本一致
    info = None
    if os.path.isfile(info_path):
        try:
            info = load_json(info_path)
        except Exception as exc:  # noqa: BLE001 - 解析失败要原样透出
            problems.append(f"info.json 解析失败: {exc}")
        if info is not None and not isinstance(info, dict):
            problems.append("info.json 顶层不是 JSON 对象")
            info = None

    if isinstance(info, dict):
        for field in REQ_FIELDS:
            if field not in info:
                problems.append(f"info.json 缺必填字段 {field}")

        # 描述类字段：四选一（description / title / summary / name），全缺只 WARN。
        # 依据：description 不在协议 §3.1 必填 14 项内（name 在其中，承担展示名）。
        desc_src = None
        for f in DESC_FIELDS:
            v = info.get(f)
            if isinstance(v, str) and v.strip():
                desc_src = f
                break
        if desc_src is None:
            warnings.append(
                "info.json 无描述类字段（description/title/summary/name 全缺）——"
                "建议补 description，当前不阻断（G-17 未要求该字段）"
            )

        pid = info.get("id")
        if isinstance(pid, str):
            if not ID_RE.match(pid):
                problems.append(f"info.json.id={pid} 不匹配 ^[a-z][a-z0-9-]*$（G-27）")
            if not name.startswith(PREFIX):
                problems.append(f"目录名 {name} 非 {PREFIX}<id> 形态（G-27）")
            else:
                suffix = name[len(PREFIX):]
                if pid != suffix:
                    problems.append(f"info.json.id={pid} ≠ 目录名后缀 {suffix}（G-27）")
        elif "id" in info:
            problems.append("info.json.id 不是字符串")

        manifest_path = os.path.join(repo, "manifest.json")
        if os.path.isfile(manifest_path):
            try:
                manifest = load_json(manifest_path)
            except Exception as exc:  # noqa: BLE001
                problems.append(f"manifest.json 解析失败: {exc}")
                manifest = None
            if isinstance(manifest, dict):
                iv = info.get("version")
                mv = manifest.get("version")
                if iv != mv:
                    problems.append(
                        f"版本不一致: info.json.version={iv} ≠ manifest.json.version={mv}"
                    )

    # 5) go.mod replace：只拦跨仓 / 绝对路径（`=> ./` 是 Go 标准做法，放行）
    gomod_path = os.path.join(repo, "go.mod")
    if os.path.isfile(gomod_path):
        with open(gomod_path, encoding="utf-8", errors="replace") as fh:
            for lineno, line in enumerate(fh, 1):
                stripped = line.strip()
                if not stripped.startswith("replace ") or "=>" not in stripped:
                    continue
                target = stripped.split("=>", 1)[1].strip()
                if target.startswith("../") or target.startswith("/"):
                    problems.append(
                        f"go.mod:{lineno} 跨仓/绝对路径 replace 禁止提交（只放 go.work）: {stripped}"
                    )

    if problems:
        n_fail += 1
        for item in problems:
            print(f"[FAIL] {name}: {item}")
    else:
        n_pass += 1
        if desc_src is not None:
            print(f"[OK] {name} (desc-source: {desc_src})")
        else:
            print(f"[OK] {name}")

    # 6) 本地 dist sha ↔ 索引记录 sha（WARN 级，只读；见文件头第 6 条）
    #    id 取 info.json（已校验与目录一致），info 读不动时退回目录后缀。
    pid_for_dist = None
    if isinstance(info, dict) and isinstance(info.get("id"), str):
        pid_for_dist = info["id"]
    elif name.startswith(PREFIX):
        pid_for_dist = name[len(PREFIX):]
    dist_dir = os.path.join(repo, "dist")
    if HAS_INDEX and pid_for_dist and os.path.isdir(dist_dir):
        dist_prefix = pid_for_dist + "-"
        for fn in sorted(os.listdir(dist_dir)):
            if not fn.startswith(dist_prefix) or not fn.endswith(".tar.gz"):
                continue
            ver = fn[len(dist_prefix):-len(".tar.gz")]
            expected = None
            # 当前版本以 plugins.json（信任根）为准，其余历史版本查账本
            cur = INDEX_PLUGINS.get(pid_for_dist)
            if (
                isinstance(cur, dict)
                and cur.get("version") == ver
                and isinstance(cur.get("sha256"), str)
            ):
                expected = cur["sha256"].strip().lower()
            else:
                for entry in INDEX_LOCK.get(pid_for_dist, []) or []:
                    if (
                        isinstance(entry, dict)
                        and entry.get("version") == ver
                        and isinstance(entry.get("sha256"), str)
                    ):
                        expected = entry["sha256"].strip().lower()
                        break
            if not expected:
                # 索引未记录该版本（pre-lock 历史版本）→ 不是本检查判据，静默跳过
                continue
            try:
                with open(os.path.join(dist_dir, fn), "rb") as fh:
                    got = hashlib.sha256(fh.read()).hexdigest()
            except OSError as exc:  # noqa: BLE001 - 读不动就报出来，不静默
                warnings.append(f"dist/{fn} 读取失败，无法比对 sha: {exc}")
                continue
            if got != expected:
                warnings.append(
                    f"DIST_SHA_DIFF {pid_for_dist} {ver} index={expected} dist={got}"
                )

    # 7) README「发布产物」版本 ↔ info.json.version（WARN 级，只读；见文件头第 7 条）
    #    解析不出就 [SKIP] 说明原因——不拿「行内任意版本号」硬猜。
    readme_path = os.path.join(repo, "README.md")
    if not isinstance(info, dict) or not isinstance(info.get("version"), str):
        print(f"[SKIP] {name}: README 发布产物版本不比对——info.json.version 不可读")
    elif not os.path.isfile(readme_path):
        print(f"[SKIP] {name}: README 发布产物版本不比对——无 README.md")
    else:
        with open(readme_path, encoding="utf-8", errors="replace") as fh:
            marker_lines = [ln for ln in fh if README_MARKER in ln]
        readme_ver = None
        skip_reason = None
        if not marker_lines:
            skip_reason = f"README 无「{README_MARKER}」段"
        else:
            hits = []
            for ln in marker_lines:
                for match in README_VER_RE.finditer(ln):
                    hits.append((match.group("pid"), match.group("ver")))
            if not hits:
                skip_reason = f"「{README_MARKER}」行内未找到 dist/<id>-<ver>.tar.gz"
            else:
                versions = sorted({v for _, v in hits})
                pids = sorted({p for p, _ in hits})
                if len(versions) > 1 or len(pids) > 1:
                    skip_reason = (
                        f"「{README_MARKER}」段内产物包名/版本不唯一: "
                        f"pids={','.join(pids)} versions={','.join(versions)}"
                    )
                elif isinstance(info.get("id"), str) and pids[0] != info["id"]:
                    skip_reason = (
                        f"产物包名 {pids[0]} 与 info.json.id {info['id']} 不一致"
                    )
                else:
                    readme_ver = versions[0]
        if skip_reason:
            print(f"[SKIP] {name}: README 发布产物版本不比对——{skip_reason}")
        elif readme_ver != info["version"]:
            warnings.append(
                f"README_VERSION_DRIFT {pid_for_dist} "
                f"info={info['version']} readme={readme_ver}"
            )

    for item in warnings:
        n_warn += 1
        print(f"[WARN] {name}: {item}")

print("")
if not HAS_INDEX:
    print("[SKIP] 索引账本不可达（INDEX_FILE / LOCK_FILE），本地 dist sha 比对跳过")
for item in index_errors:
    print(f"[WARN] 索引账本读取失败，dist sha 比对可能不完整: {item}")
print("检查范围: 三件套 + info.json 必填 14 字段(协议 §3.1 ∪ G-17 ∪ G-20) + "
      "描述类字段四选一(WARN) + id/目录一致(G-27) + info/manifest 版本一致 + "
      "go.mod replace 跨仓拦截 + 本地 dist sha ↔ 索引记录 sha(WARN, DIST_SHA_DIFF) + "
      "README 发布产物版本 ↔ info.json.version(WARN, README_VERSION_DRIFT)")
print(f"store-check: {n_pass} pass, {n_fail} fail, {n_warn} warn")
sys.exit(1 if n_fail else 0)
PY
