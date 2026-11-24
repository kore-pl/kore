#!/usr/bin/env bash
# kore 产品可用性门禁（G-33）
#
# 用法: bash scripts/usability-check.sh [--self-test] [--no-run-tests] [--help]
#
# 判据（G-33 原文，不放宽）：
#   自动 7 条
#     A1 写操作零参数不得返回 E_INVALID（允许 E_NEED_ROOT / E_UNAVAILABLE / E_CONFIRM_REQUIRED）
#        实现：插件仓必须有命中 `func Test.*ZeroParam` 的 in-process 用例（package main 的
#        dispatch() 或 internal/* 的 Call()，fakeExec 级替身，不碰真系统），
#        并由本段 `GOWORK=off go test -run ZeroParam -count=1 ./...` 真跑 PASS。
#        只登记不跑 = 空口声明，按不满足处理。
#     A2 info.json 必填 presets；create 类插件（methods 含 *.create / *.add）≥1 个预设
#     A3 invalid("...") 的 message ≥8 字且含「请/应/需/例/如」（变量入参无法静态核对，计入 unverified）
#     A4 用户可见字符串零内部术语（实例 / 生命周期 / capability / revision）
#        扫 web/*.js（主壳视图）与插件 web/*.js|*.html 的字符串字面量；整行注释不计
#     A5 每个视图必须有空状态 + 跳转（empty-state + button/navigate/scrollIntoView）
#        视图集合 = web/app.js 的 SHELL_ROUTES 引用到的懒加载模块 + 内联视图（app.js）
#     A6 一级菜单 ≤10 且 store / plugins 不得并存（web/app.js SHELL_ROUTES 的 id 数）
#     A7 主流程 ≤3 点击（web/usability.yaml 的 views.<id>.main_flow 标注）
#   人工 4 条（WARN，不自动判）
#     M1 抽 3 个错误码看「怎么办」；M2 小白 60 秒完成；M3 空状态按钮可达；
#     M4 对标宝塔差距记入 docs/PLUGIN-MATURITY.md §3.5
#
# 分层上线（存量不一次性打红）：
#   违规登记在 scripts/usability-pending.txt → [WARN]，不阻断
#     格式：`<规则> <目标>` 全部豁免；`<规则> <目标> <N>` 只豁免按序前 N 条，
#     超出 N 条的新违规仍 [FAIL]（防止「登记一个插件就永久免疫」）
#   未登记（新增违规） → [FAIL]，本脚本 exit 1
#   清单条目已不再违规 / 条数下降 → [WARN] 提示移除或下调 N（转硬判据）
#   make check 第 20 段只取 WARN 级（打印 N 处 FAIL 但不阻断），与 store-check 分层口径一致；
#   脚本单跑仍为严格判据（exit 1），转阻断只需把 make check 的调用改成 if ! bash ...。
#
# 不联网、不调 git、不改仓库文件；A1 的 go test 只写 GOCACHE 与 t.TempDir()。
# 退出码：0 无 FAIL；1 有 FAIL；2 参数错误。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export USABILITY_ROOT="$ROOT"

exec python3 - "$@" <<'PY'
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.environ.get("USABILITY_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_REPOS_DIR = os.environ.get("PLUGIN_REPOS_DIR") or os.path.join(ROOT, "..")
WEB_DIR = os.environ.get("USABILITY_WEB_DIR") or os.path.join(ROOT, "web")
ROUTES_FILE = os.environ.get("USABILITY_ROUTES_FILE") or os.path.join(WEB_DIR, "app.js")
YAML_FILE = os.environ.get("USABILITY_YAML_FILE") or os.path.join(WEB_DIR, "usability.yaml")
PENDING_FILE = os.environ.get("USABILITY_PENDING_FILE") or os.path.join(ROOT, "scripts", "usability-pending.txt")
TEST_TIMEOUT = int(os.environ.get("USABILITY_TEST_TIMEOUT", "120"))

ARGS = set(sys.argv[1:])
if "--help" in ARGS or "-h" in ARGS:
    print(__doc__ or "用法: bash scripts/usability-check.sh [--self-test] [--no-run-tests]")
    sys.exit(0)
SELFTEST = "--self-test" in ARGS
NO_RUN_TESTS = "--no-run-tests" in ARGS or SELFTEST
for a in ARGS:
    if a not in ("--self-test", "--no-run-tests"):
        print(f"未知参数: {a}（--help 看用法）", file=sys.stderr)
        sys.exit(2)

JARGON = ["实例", "生命周期", "capability", "revision"]
POLITE = ("请", "应", "需", "例", "如")
WRITE_CREATE = re.compile(r"\.(create|add)$")

violations = []  # (rule, target, detail)
unverified = []


def add(rule, target, detail):
    violations.append((rule, target, detail))


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def plugin_dirs():
    if not os.path.isdir(PLUGIN_REPOS_DIR):
        return []
    out = []
    for name in sorted(os.listdir(PLUGIN_REPOS_DIR)):
        if not name.startswith("kore-plugin-"):
            continue
        path = os.path.join(PLUGIN_REPOS_DIR, name)
        if os.path.isdir(path) and os.path.isfile(os.path.join(path, "info.json")):
            out.append((name[len("kore-plugin-"):], path))
    return out


def load_info(plugin_dir):
    try:
        with open(os.path.join(plugin_dir, "info.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---------- A1 零参数写操作 ----------
def a1(pid, pdir):
    hits = []
    for base, _, files in os.walk(pdir):
        if "node_modules" in base or "/.git" in base:
            continue
        for fn in files:
            if fn.endswith("_test.go") and re.search(r"func\s+Test\w*ZeroParam", read(os.path.join(base, fn))):
                hits.append(os.path.relpath(os.path.join(base, fn), pdir))
    if not hits:
        add("A1", pid, "无命中 Test.*ZeroParam 的 in-process 零参数用例")
        return
    if NO_RUN_TESTS:
        return
    try:
        proc = subprocess.run(
            ["go", "test", "-run", "ZeroParam", "-count=1", "./..."],
            cwd=pdir, env={**os.environ, "GOWORK": "off"},
            capture_output=True, text=True, timeout=TEST_TIMEOUT,
        )
    except FileNotFoundError:
        add("A1", pid, "go 不可用，无法真跑 ZeroParam 用例")
        return
    except subprocess.TimeoutExpired:
        add("A1", pid, f"ZeroParam 真跑超时（>{TEST_TIMEOUT}s）")
        return
    if proc.returncode != 0:
        tail = (proc.stdout + proc.stderr).strip().splitlines()[-3:]
        add("A1", pid, "ZeroParam 真跑失败: " + " / ".join(tail))


# ---------- A2 presets ----------
def a2(pid, pdir):
    info = load_info(pdir)
    if info is None:
        add("A2", pid, "info.json 无法解析")
        return
    presets = info.get("presets")
    if presets is None:
        add("A2", pid, "info.json 缺必填 presets")
        return
    if not isinstance(presets, list):
        add("A2", pid, "presets 必须是数组")
        return
    if any(isinstance(m, str) and WRITE_CREATE.search(m) for m in info.get("methods") or []) and not presets:
        add("A2", pid, "create 类插件 presets 为空")


# ---------- A3 invalid() 文案 ----------
INVALID_LIT = re.compile(r'invalid\(\s*"((?:[^"\\]|\\.)*)"')
INVALID_ANY = re.compile(r"invalid\(\s*([^)\s]+)")


def a3(pid, pdir):
    for base, _, files in os.walk(pdir):
        if "node_modules" in base or "/.git" in base:
            continue
        for fn in files:
            if not fn.endswith(".go") or fn.endswith("_test.go"):
                continue
            src = read(os.path.join(base, fn))
            rel = os.path.relpath(os.path.join(base, fn), pdir)
            for m in INVALID_LIT.finditer(src):
                msg = m.group(1)
                if len(re.sub(r"\\.", "", msg)) < 8 or not any(p in msg for p in POLITE):
                    add("A3", pid, f"{rel} 文案不合格（<8字或缺请/应/需/例/如）: {msg}")
            for m in INVALID_ANY.finditer(src):
                if not m.group(1).startswith('"'):
                    unverified.append(f"A3 {pid} {rel}: invalid({m.group(1)}) 变量入参无法静态核对")


# ---------- A4 内部术语 ----------
STR_LIT = re.compile(r"""(['"])((?:\\.|(?!\1).)*)\1""")


def scan_jargon(path, label):
    is_html = path.endswith(".html")
    for lineno, line in enumerate(read(path).splitlines(), 1):
        s = line.strip()
        if s.startswith("//") or s.startswith("*") or s.startswith("/*") or s.startswith("<!--"):
            continue
        if is_html:
            for term in JARGON:
                if term in line:
                    add("A4", label, f"第 {lineno} 行用户可见文案含「{term}」: {line.strip()[:60]}")
            continue
        for _, lit in STR_LIT.findall(line):
            for term in JARGON:
                if term in lit:
                    add("A4", label, f"第 {lineno} 行用户可见字符串含「{term}」: {lit[:60]}")


def a4(pid, pdir):
    web = os.path.join(pdir, "web")
    if os.path.isdir(web):
        for fn in sorted(os.listdir(web)):
            if fn.endswith((".js", ".html")):
                scan_jargon(os.path.join(web, fn), f"{pid}/web/{fn}")


def a4_shell():
    for fn in sorted(os.listdir(WEB_DIR)):
        if fn.endswith(".js"):
            scan_jargon(os.path.join(WEB_DIR, fn), f"web/{fn}")


# ---------- 视图/一级菜单注册表 ----------
# 稳定契约不是文件名，而是「一级路由注册表」这个结构：app.js 的 SHELL_ROUTES（当前）
# 或 hub 重构后的 HUB_DEFS / HUB_ROUTES / FIRST_LEVEL_ROUTES。在 web/*.js 全域搜索，
# 避免门禁绑死在某个正在被重构的文件上。
REGISTRY = re.compile(r"(?:SHELL_ROUTES|HUB_DEFS|HUB_ROUTES|FIRST_LEVEL_ROUTES)\s*=\s*\[(.*?)\];", re.S)
MODULE_REF = re.compile(r"""'/assets/([A-Za-z0-9_.-]+\.js)'""")


def find_registry():
    for fn in sorted(os.listdir(WEB_DIR)):
        if not fn.endswith(".js"):
            continue
        src = read(os.path.join(WEB_DIR, fn))
        m = REGISTRY.search(src)
        if m and re.search(r"id\s*:\s*'", m.group(1)):
            return fn, m.group(1)
    return None, ""


def route_ids(found=None):
    fn, block = found if found else find_registry()
    if not block:
        return []
    return re.findall(r"id\s*:\s*'([a-z][a-z0-9-]*)'", block)


def view_files(found=None):
    """返回 [label]，每个视图一条：懒加载模块文件，或内联视图统一指向注册表所在文件。"""
    fn, block = found if found else find_registry()
    if not block:
        return []
    files = sorted({f"web/{f}" for f in MODULE_REF.findall(block)})
    if re.search(r"render\s*:\s*(?!moduleView)", block):
        files.append(f"web/{fn}")
    return files


# ---------- A5 空状态 + 跳转 ----------
JUMP = re.compile(r"navigate\(|data-route|scrollIntoView|button\(")


def a5(files):
    for label in files:
        path = os.path.join(ROOT, label) if label.startswith("web/") else os.path.join(WEB_DIR, label)
        if not os.path.isfile(path):
            add("A5", label, "视图文件不存在")
            continue
        src = read(path)
        if "empty-state" not in src:
            add("A5", label, "无空状态（empty-state）")
        if not JUMP.search(src):
            add("A5", label, "空状态无跳转（button/navigate/scrollIntoView）")


# ---------- A6 一级菜单 ----------
def a6(ids, found):
    if not ids:
        fn, _ = found
        add("A6", f"web/{fn or '?'}#registry", "无法解析一级菜单注册表（SHELL_ROUTES / HUB_DEFS 均缺失或格式漂移）")
        return
    fn, _ = found
    if len(ids) > 10:
        add("A6", f"web/{fn}", f"一级菜单 {len(ids)} 项 > 10")
    if "store" in ids and "plugins" in ids:
        add("A6", f"web/{fn}", "一级菜单 store 与 plugins 并存")


# ---------- A7 usability.yaml ----------
def a7(ids):
    src = read(YAML_FILE)
    entries = {}
    cur = None
    for line in src.splitlines():
        m = re.match(r"^\s{2}([a-z][a-z0-9-]*):\s*$", line)
        if m:
            cur = m.group(1)
            entries[cur] = []
            continue
        m = re.match(r"^\s{4}main_flow:\s*\[(.*)\]\s*(#.*)?$", line)
        if m and cur:
            entries[cur] = [s.strip().strip("'\"") for s in m.group(1).split(",") if s.strip()]
    for vid in ids:
        steps = entries.get(vid)
        if not steps:
            add("A7", f"web/usability.yaml#{vid}", "缺 views.<id>.main_flow 标注")
        elif len(steps) > 3:
            add("A7", f"web/usability.yaml#{vid}", f"主流程 {len(steps)} 步 > 3")


# ---------- 汇总 ----------
def load_pending():
    out = {}
    for line in read(PENDING_FILE).splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) == 2:
            out[(parts[0], parts[1])] = None  # 全部豁免
        elif len(parts) == 3 and parts[2].isdigit():
            out[(parts[0], parts[1])] = int(parts[2])  # 只豁免前 N 条
    return out


def report(viol, pending):
    grouped = {}
    for rule, target, detail in sorted(viol):
        grouped.setdefault((rule, target), []).append((rule, target, detail))
    warn = fail = 0
    for key in sorted(grouped):
        items = grouped[key]
        limit = pending.get(key, "absent")
        if limit == "absent":
            for _, _, detail in items:
                print(f"[FAIL] {key[0]} {key[1]}: {detail}")
            fail += len(items)
            continue
        allowed = len(items) if limit is None else min(limit, len(items))
        for i, (_, _, detail) in enumerate(items):
            if i < allowed:
                warn += 1
                print(f"[WARN] {key[0]} {key[1]}: {detail}（usability-pending.txt 存量豁免）")
            else:
                fail += 1
                print(f"[FAIL] {key[0]} {key[1]}: {detail}（超出登记条数 {allowed}，新增违规）")
        if limit is not None and len(items) < limit:
            print(f"[WARN] {key[0]} {key[1]}: 清单登记 {limit} 条、实际 {len(items)} 条，请下调")
    for key in sorted(pending):
        if key not in grouped:
            print(f"[WARN] {key[0]} {key[1]}: 清单条目已不再违规，请从 usability-pending.txt 移除")
    return warn, fail


def run(ids, files):
    plugins = plugin_dirs()
    for pid, pdir in plugins:
        a1(pid, pdir)
        a2(pid, pdir)
        a3(pid, pdir)
        a4(pid, pdir)
    a4_shell()
    found = find_registry()
    a5(files)
    a6(ids, found)
    a7(ids)
    return plugins


def main():
    if SELFTEST:
        return selftest()
    found = find_registry()
    ids = route_ids(found)
    files = view_files(found)
    plugins = plugin_dirs()
    if not plugins:
        print(f"[FAIL] 未找到任何 ../kore-plugin-*/info.json（PLUGIN_REPOS_DIR={PLUGIN_REPOS_DIR}）")
        return 1
    run(ids, files)
    pending = load_pending()
    warn, fail = report(violations, pending)
    print(f"usability-check: {len(violations) - warn - fail} pass, {warn} warn, {fail} fail, "
          f"{len(unverified)} unverified（{len(plugins)} 插件 / {len(ids)} 一级菜单 / {len(files)} 视图）")
    for u in unverified[:8]:
        print(f"[INFO] {u}")
    if len(unverified) > 8:
        print(f"[INFO] …另有 {len(unverified) - 8} 处变量入参（人工 WARN 面）")
    if fail:
        print("[FAIL] G-33 有新违规：修插件/视图，或登记到 scripts/usability-pending.txt 并写明裁决期限")
        return 1
    return 0


# ---------- 自证：正例 PASS + 四反例 FAIL ----------
def write_fixture(base, *, presets=True, invalid_msg='请选择备份预设后再试', jargon=False, nav_extra=False):
    pdir = os.path.join(base, "kore-plugin-foo")
    os.makedirs(os.path.join(pdir, "web"))
    info = {"id": "foo", "name": "示例", "version": "0.1.0", "methods": ["foo.create"]}
    if presets:
        info["presets"] = [{"id": "site-full", "label": "网站全量"}]
    with open(os.path.join(pdir, "info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False)
    with open(os.path.join(pdir, "methods.go"), "w", encoding="utf-8") as f:
        f.write('package main\n\nfunc invalid(msg string) {}\n\n'
                'func create() {\n\tinvalid("' + invalid_msg + '")\n}\n')
    with open(os.path.join(pdir, "methods_test.go"), "w", encoding="utf-8") as f:
        f.write("package main\n\nimport \"testing\"\n\nfunc TestZeroParamCreate(t *testing.T) {}\n")
    with open(os.path.join(pdir, "web", "index.html"), "w", encoding="utf-8") as f:
        f.write("<button>创建备份</button>" + ("<p>共有 3 个实例</p>" if jargon else ""))

    web = os.path.join(base, "web")
    os.makedirs(web)
    ids = ["dashboard", "store", "files", "sites", "tasks", "monitor", "settings", "backup"]
    if nav_extra:
        ids += ["plugins", "logs", "ssl"]
    route_lines = []
    for vid in ids:
        if vid == "backup":
            route_lines.append("    { id: 'backup', label: '备份', render: moduleView('K', '/assets/backups.js', '备份') },")
        else:
            route_lines.append(f"    {{ id: '{vid}', label: '{vid}', render: renderX }},")
    with open(os.path.join(web, "app.js"), "w", encoding="utf-8") as f:
        f.write("function f(){}\nvar b='<div class=\"empty-state\">暂无</div>';\n"
                "function g(){ navigate('store'); }\n"
                "var SHELL_ROUTES = [\n" + "\n".join(route_lines) + "\n];\n")
    with open(os.path.join(web, "backups.js"), "w", encoding="utf-8") as f:
        f.write("var s='<div class=\"empty-state\">暂无</div>';\nfunction g(){ button(x,'去创建'); }\n")
    with open(os.path.join(web, "usability.yaml"), "w", encoding="utf-8") as f:
        f.write("# 视图主流程标注\nviews:\n")
        for vid in ids:
            f.write(f"  {vid}:\n    main_flow: [打开页面, 点主按钮]\n")
    return base


def selftest():
    cases = [
        ("正例（backup 式：预设+好文案+无术语+≤10 导航+标注完整）", {}, 0),
        ("反例① 去掉 presets", {"presets": False}, 1),
        ("反例② message 改成纯错误码", {"invalid_msg": "E_INVALID"}, 1),
        ("反例③ UI 字符串加「实例」", {"jargon": True}, 1),
        ("反例④ 导航加到 11 项（并让 store/plugins 并存）", {"nav_extra": True}, 1),
    ]
    all_ok = True
    for name, kwargs, want in cases:
        with tempfile.TemporaryDirectory() as tmp:
            base = write_fixture(os.path.join(tmp, "fx"), **kwargs)
            globals().update(
                PLUGIN_REPOS_DIR=base,
                WEB_DIR=os.path.join(base, "web"),
                ROUTES_FILE=os.path.join(base, "web", "app.js"),
                YAML_FILE=os.path.join(base, "web", "usability.yaml"),
                PENDING_FILE=os.path.join(tmp, "empty-pending.txt"),
            )
            violations.clear()
            found = find_registry()
            ids = route_ids(found)
            run(ids, view_files(found))
            lines = [f"{r} {t}: {d}" for r, t, d in sorted(violations)]
            ok = (len(lines) == want) if want == 0 else (len(lines) >= 1)
            all_ok = all_ok and ok
            print(f"[{'OK' if ok else 'FAIL'}] self-test {name}: 违规 {len(lines)} 条（期望 {'0' if want == 0 else '≥1'}）")
            for line in lines:
                print(f"       {line}")
    print("[OK] self-test 全部通过：正例 PASS、四反例均被拦下" if all_ok else "[FAIL] self-test 未通过")
    return 0 if all_ok else 1


sys.exit(main())
PY
