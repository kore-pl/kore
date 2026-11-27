# Python ext P1+P2 独立验收（G-09 / task-291）

> 2026-11-28 · verifier `pyext-verifier`（独立于 implementer `pyext-impl`）· 只读复跑，不改任何代码 / 配置、不启服务、不碰主实例 8787 / `.kore-local-*` / 宿主 site-packages · 工作目录 `/home/pt/Work/GolandProjects/kore-pl`

## 0. 受验对象

| 仓 | HEAD | 提交主题 | DCO |
| --- | --- | --- | --- |
| kore-plugin-runtime-python | `f3cc4fda165cf5c43f5288b89cc57dfd2702903f` (f3cc4fd) | `[agent:pyext-impl] feat(pyop): 隔离扩展管理 ext.install/list/remove + bump v0.5.0` | `Signed-off-by: pengtang1024 <pengtang1024@qq.com>` ✓ |
| kore-plugins | `44e525ceea1775e472ba58a4d1c7e17d28b3e0fd` (44e525c) | `[agent:pyext-impl] chore(index): 同步 runtime-python 0.5.0（sha/size/versions.lock/presets/market 重签）` | DCO ✓ |
| kore | `afcf5c840049641b94ce9848ca80d6943a61f536` (afcf5c8) | `[agent:pyext-impl] feat(runtimes): Python tab 复用扩展面板（EXT_CFG + en-US + G-28 双端证据）` | DCO ✓ |

三仓 HEAD 与任务卡给定 commit 完全一致。

---

## 1. 后端读码 + 复跑

### 1.1 ext.go 三方法读码（`kore-plugin-runtime-python/internal/pyop/ext.go`，481 行）

- **install**（`callExtInstall` :102 / `InstallPackages` :286）：固定 argv `python3 -m pip install --target <prefix> --no-input --disable-pip-version-check <包名...>`，`exec.CommandContext`（:466）无 `sh -c` / 无 `--user` / 无 `--break-system-packages`；前缀由 `resolveExtPrefix` 从 stateRoot 算出，不接受调用方路径（`extInstallParams` 只有 `packages`，`strictUnmarshal` `DisallowUnknownFields` 挡 `prefix`/`venv_path`）。✓
- **remove**（`RemovePackages` :306）：标准库受控文件删除，无 argv、无子进程（`extFake` runner 注入测试断言 runner 未被调用，ext_test.go:208-219）；PEP 503 归一 `pyExtName`（lower + `-`→`_`，:437）+ `pyExtNameMatches`（:444）匹配 dist-info/egg-info；`filepath.Rel` containment（:331-334）+ 软链 `EvalSymlinks` 后 `within(realPrefix, target)`（:335-340）挡逃逸；只删 `<state>/global/py_ext` 前缀内条目；「固定 argv 无子进程」要素 N/A 附理由（ext.go:20-21 注释 + 报告中说明 pip uninstall 无 `--target`）。✓
- **list**（`ListPackages` :358）：只读 `*.dist-info/METADATA`，`*.egg-info/PKG-INFO` 兜底（:377-384）；`Rel` + METADATA 软链 `EvalSymlinks` containment（:385-396）；目录不存在返回 `ErrExtPrefixMissing`，`callExtList` 吞为空态（:141-143）；`readExtMetadata` 解析 Name/Version，缺失用目录名 + 正则兜底（:409-434）。✓

### 1.2 六要素逐条核对

| 要素 | 证据 | 判定 |
| --- | --- | --- |
| resolveExtPrefix 不接受调用方路径 + 挡逃逸 | :191-230：trim/空白/NUL/反斜杠/相对/`..` 段全拒；`realAncestor` 对 root、global、py_ext 最近存在祖先 `EvalSymlinks`，全部须 `within(realRoot, real)`；ext_test.go:129-164 覆盖 4 类坏 root + global/py_ext 两处软链逃逸 | ✓ |
| 包白名单复用 venv.go 正则 | :262 `packageSpecPattern.MatchString`（定义在 venv.go:33，未复制）；ext_test.go:95-127 覆盖 `-g`/`--user`/`--index-url`/分号/空格/`$()`/反引号/`../`/绝对路径/空/未知字段，`fake.installCalls==0` 证明校验失败不触达执行面 | ✓ |
| 120s → E_UPSTREAM | `VenvCommandTimeout=120*time.Second`（venv.go:24）；`runExtCommand` 超时返回 `ErrExtTimeout`（:471-473）；`classify` 映射 `ErrExtTimeout → upstream`（call.go:166-167）；ext_test.go:222-236 双路径断言 | ✓ |
| 64KiB 截断 | `MaxPipOutputBytes=64*1024`（venv.go:28）复用 `truncatePipOutput`（venv.go:375）；ext.go:122/178/296/352 四处调用；ext_test.go:166-179 断言首尾截断 + 标记 + truncated 标志 | ✓ |
| fake 全测 | extFake（ext_test.go:16-52）在 stubExecutor 上实现 ExtManager，记录 prefix/packages 与调用次数；install/list/remove 三方法入参/结果/错误路径全用假执行面覆盖 | ✓ |
| 固定 argv（install）/ remove N/A 附理由 | ext_test.go:183-220 `TestExtRealManagerArgv` 断言 argv 前缀、禁用项、包名透传、remove 不起子进程；理由见 §1.1 | ✓ |

### 1.3 capability / 方法面 / 版本

- `call.go` `businessVerb` 白名单含 20 动词（ext.install/list/remove 在内），`dispatch` 三 case 到位；`info.json` `method_capabilities` 共 **20 条**（原 17 → 20）：`ext.install`/`ext.remove` = `system:admin`、`ext.list` = `system:read`；插件级 capabilities 不变（`system:admin`, `proc:write`），无新增 root_action；`manifest.json` 与 info.json 版本/能力一致。✓
- `capability_test.go` 期望表 20 动词与 info.json 双向校验（条数相等、能力值相等、6 项特权能力域收窄、businessVerb 一致、拒绝未声明的 `exec`）；实测 go test 全绿。✓
- 版本：`info.json`/`manifest.json` = `0.5.0`，`CHANGELOG.md` 记 `0.4.2 → 0.5.0` feat→minor，七语言 `DETAIL*.md`/`locale/*.json` 同步；全仓 grep 无遗留 `0.4.2` 作为当前版本（仅 CHANGELOG/DESIGN 历史引用）。✓
- `ext_test.go` **8 个测试用例**（TestExtInstallPrefixIsolated / RejectsInjection / PrefixRejectsEscape / TruncateOutput / RealManagerArgv / ClassifyTimeout / ListReadsDistInfo / RemoveControlled），断言覆盖面经逐行读码核实，非仅「测试绿」。✓

### 1.4 门禁复跑（命令 + 退出码）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `GOCACHE=<工作区临时> GOMODCACHE=<工作区临时> GOWORK=off go test -count=1 -timeout 200s ./...` | **0** | 4 包全 ok（root / internal/pyop / tests/e2e / tests/fault） |
| 同上 + `GOPROXY=off`（模块已缓存后离线复跑） | **0** | 4 包全 ok |
| `GOCACHE=<临时> GOMODCACHE=<临时> GOPROXY=off make check` | **0** | `gofmt: clean` / `go vet` 无输出 / `go test` 4 包 ok / race 段 `[SKIP] 无 tests/boundary` |

> 说明：首次运行经配置的 goproxy 拉取依赖 `pluginapi v0.1.3`（构建依赖，非业务联网）；其后 `GOPROXY=off` 离线复跑通过。所有临时缓存用完已删净（见 §6）。

---

## 2. 前端复核（kore 仓）

- `web/runtimes.js` diff：仅 `EXT_CFG` 加 `runtime-python` 条目（:29-37）+ 三处注释同步；消费路径 `loadExts`/`extPanel`/`extInstall`/`extRemove` 全走 `EXT_CFG[t.domain]`（:222/:323/:340/:603/:930/:948），Python tab 复用现成 `extPanel`，**零新增一级控件 / CSS / hub**。`tr()`（:84-97）缺键回退中文，中文态零影响。✓
- `web/i18n/en-US.js`：7 条英文串（`runtimes.ext.py.*`）进懒加载英文包；主壳 `web/index.html` 仅加载 `i18n-zh-CN.js`，en-US 由 `i18n.js` 按需加载（`web/i18n.js:6 SUPPORTED=['zh-CN','en-US']`），英文串不占首屏。✓
- `node --check web/runtimes.js` → exit **0**；`node --check web/i18n/en-US.js` → exit **0**（node v24.21.0）。✓
- `make frontend` → exit **0**：首屏 gzip **91092 B ≤ 307200 B（300 KiB）**，`i18n` 增量 **2941 B ≤ 3072 B（3 KiB）**；与任务卡期望数字逐字节一致。✓
- `bash scripts/usability-check.sh`：
  - 默认 GOCACHE 只读时 19 FAIL（16 条 `read-only file system` 环境与 waf 相关，非功能缺陷）；
  - 换工作区可写 GOCACHE 后：**1 条真 FAIL = `A1 waf: ZeroParam`（已单独复跑确认根因 `unshare: 不允许的操作`，沙箱限制）**，`runtime-python` 仅 1 条 WARN（提示清单条目已不再违规），**pyext 新增 FAIL = 0**。与任务卡「仅存量 waf unshare」一致。✓

---

## 3. G-28 四图实读

`identify` + `file` + `read_image` 逐张实读（非仅看元数据）：

| 文件 | identify | 实读观察 |
| --- | --- | --- |
| `ui-py-ext-desktop.png` | 1440x1725 | 真页面全页：网站→运行环境→Python tab，「扩展管理」面板完整可见，副标题 / 输入框 placeholder `requests==2.31.0 flask` / 安装按钮 / 空态「还没有隔离扩展…」；页面错误 0 |
| `ui-py-ext-desktop-viewport.png` | 1440x900 | PC 视口：版本列表 / 进程守护 / 虚拟环境，「扩展管理」标题在底部露出，非同图缩放 |
| `ui-py-ext-mobile.png` | 390x844 | 手机滚动到扩展管理面板：标题 / 副标题 / 输入 / 安装按钮 / 空态单列，无横向溢出 |
| `ui-py-ext-mobile-viewport.png` | 390x844 | 手机顶视口：顶栏图标 + 底部 tab 条 + 运行环境 tab 高亮，与桌面视口构图不同 |

四张 sha256 互不相同（`af563638…` / `6cde4e63…` / `9cf56ba4…` / `0ffe4fb9…`），非同图缩放冒充；含扩展面板 + 空态，非伪造。✓

`ui-py-ext-selfeval.md` 三问：问1 用户问题（隔离装包、不污染宿主）✓；问2 与宝塔/1Panel 差距（白名单窄 / 无依赖树 / 受控删除 / 需自加 PYTHONPATH，列 4 条有意边界）✓；问3 判「可用（机制层面）」并给 UI/API/门禁三类判据 ✓。**诚实边界**：明确「真机联网 pip install（真从 PyPI 下载）不在本卡验证范围，本卡不声称真机通过」——本 verifier 也不做真机 PyPI 验证（禁联网业务），如实记录为未验证。✓

---

## 4. 索引一致性（kore-plugins）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `bash scripts/validate-index.sh` | **0** | `[OK] 签名校验：开启（ed25519 全量验签）`、schema 24 条 / 版本单调 / 预设引用 / market 逐字节 / `ed25519 签名验证通过（内置公钥）` / 全部通过 |
| `bash scripts/build-market.sh --check` | **0** | `[OK] market/plugins.js 与索引逐字节一致（24 个插件）` |
| `bash scripts/validate-presets.sh` | **0** | 8 个预设 / 24 插件 / 0 FAIL / 0 WARN |

**dist sha `cc9d8712…` 四处一致**（完整值 `cc9d8712575f6d04c4192c9ceb25aaf5732a516b1bdcd6c3f71b07b20182252a`）：
1. 实际 tarball `sha256sum`（`kore-plugin-runtime-python/dist/runtime-python-0.5.0.tar.gz`）
2. `dist/runtime-python-0.5.0.tar.gz.sha256`（:1）
3. `kore-plugins/index/plugins.json`（:209）
4. `kore-plugins/index/versions.lock.json`（:572）

**size ±2**：tarball 实际 `1606036` B；`index/plugins.json:208 size_bytes=1606036`（差 0）；`info.json size_bytes=1606034`（差 2，落在 Makefile `dist` 收敛口径 ±2 内）。✓

market/plugins.js runtime-python 条目 version=0.5.0；presets/dev.json:20 与 full.json:70 version 均 0.5.0；索引 :205 version=0.5.0。✓

---

## 5. git 提交 / 工作树

- 三仓 commit 路径精确：f3cc4fd（21 文件：`info.json`/`manifest.json`/`call.go`/`capability_test.go`/新增 `ext.go`+`ext_test.go`/CHANGELOG/七语言 DETAIL/locale）、44e525c（6 文件：index 3 + market + presets 2）、afcf5c8（7 文件：4 截图 + selfeval + en-US.js + runtimes.js）；全部 DCO `Signed-off-by` 齐备。✓
- **未 push**：`rev-list --left-right --count origin/main...HEAD` = python `0 2` / plugins `0 1` / kore `0 1`（本地领先、远端无新提交）；HEAD 无 tag。✓
- `git worktree list` 三仓均 **1 行主树**，无 `wt-*` 残留。✓
- 他人 dirty 原样未动：
  - `kore-plugin-runtime-python`: `?? internal/pyop/zeroparam_test.go`（他人未跟踪，原样）
  - `kore`: `M scripts/usability-pending.txt`（他人未暂存改动）+ `?? .agents/verify/e2e-*.md`、`?? .agents/verify/*.md`、`?? .agents/.agents/`、`?? data/`、`?? dist/`、`?? .agents/verify/screenshots/adp-debug-desktop-01.png`（全部原样）
  - `kore-plugins`: `?? .tmp-validate-out.txt`（mtime 11-25，存量）、`?? dist/`（存量）
  - `kore/.agents/verify/backup-download-verification.md:125` 的存量 secret FAIL 描述未改动（文件 tracked 且 clean）。✓
- 本 verifier 除本报告外零文件改动；`make frontend` 只重建 gitignored `web/dist`（不改跟踪文件）。✓

---

## 6. 临时缓存清理

本 verifier 创建的 `.gocache-pyext-verifier` / `.gomodcache-pyext-verify-mod` / `.tmp/usability-gocache-v` / `.tmp/usability-pyext-verify*.log` / 临时 waf 验证 cache 已全部删除并 `realpath` 校验路径后清理（Go modcache 只读文件先 `chmod u+w` 再删）；实现者隔离截图实例目录 `.agents/verify/.tmp-pyext-shot` 复核已不存在。✓

---

## 7. 结论

| 复核域 | 结论 |
| --- | --- |
| 后端三方法 + 六要素 + capability + 版本 + go test/make check | PASS |
| 前端 EXT_CFG 复用 / en-US 懒加载 / node --check / make frontend / usability 新增 FAIL=0 | PASS |
| G-28 四图实读 + 三问自评 + 真机 PyPI 未验证诚实标注 | PASS |
| 索引 validate/build-market --check / dist sha 四处 / size ±2 | PASS |
| git 三仓 commit 精确 + DCO + 未 push + worktree 仅主树 + 他人 dirty 原样 + 缓存删净 | PASS |

**总评：PASS（5/5 域全通过；无 BLOCKED 项）。** 唯一现存 FAIL 为存量 waf e2e 的 `unshare: 不允许的操作`（沙箱环境限制，非本次 pyext 改动引入），已如实记录。
