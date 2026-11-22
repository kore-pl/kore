> 状态: draft · 归属: architect · 更新: 2026-11-23 · 里程碑: M5

# RELEASE — 插件发版规则（版本号 = 包内容的唯一标识）

## 0. 一条硬规则

同一 `id@version` 在索引与 release 中**只允许对应一个 sha256**。包内容变了、版本没变，用户按版本号判断就会装到另一份构建上；这是 P0 级流程缺陷。

## 1. 何时 bump

| 改动性质 | 级别 | 例 |
| --- | --- | --- |
| feat（新增能力/方法/界面） | minor +1（0.x 主版本不动，0.2.0 → 0.3.0） | 新方法、真实执行面替换 noop |
| fix / refactor / perf / docs 影响产物 | patch +1 | 逻辑修复、方法改名、嵌入清单调整 |
| 纯文档 / 测试、且不改 dist | 不 bump | 只改 README 注释、测试用例 |
| **任何改变 dist 包 sha 的改动** | **必须 bump** | 打包脚本、`manifest.json`、`info.json.size_bytes`、Go 源码 |

唯一判据：

```bash
sha256sum dist/<id>-<version>.tar.gz          # 与索引同版本 sha 比对
# 不相等 → 必须 bump；禁止改索引 sha 了事
```

## 2. 发版清单（顺序不可跳）

1. **bump**：`info.json` 与 `manifest.json` 的 `version` 同步 +1；`CHANGELOG.md` 顶部加新版本条目（摘要从 `git log <上版本tag>..HEAD` 提取）。
2. **打包**：`make build && make dist`；导出 `sha256` 与 `size_bytes`。
3. **可复现**：同树 `make dist` 两次 sha 一致；`git archive HEAD | tar -x -C /tmp/x && cd /tmp/x && make dist` 的 sha 与第 2 步一致。
4. **提交**：`chore(release): bump vX.Y.Z`（只含 `info.json` / `manifest.json` / `CHANGELOG.md`，用 `kore/scripts/safe-commit.sh`）。
5. **发布**：`git tag -a vX.Y.Z` → push → `gh release create vX.Y.Z dist/<id>-<version>.tar.gz`。
6. **索引**：更新 `kore-plugins/index/plugins.json` 的 `version` / `sha256` / `size_bytes` / `download_url`；把新版本追加到 `index/versions.lock.json`；同步 `presets/*.json` 的固定版本。
7. **重签**：`KORE_INDEX_KEY=<seed> bash scripts/sign-index.sh` → `bash scripts/validate-index.sh` 正向 exit 0、篡改正文反例非 0 → `make check`。
8. **市场页 + 重启**：`bash scripts/build-market.sh`；换公钥必须 `cd ../kore && make build` 并重启 kored（公钥是编译期常量），见 [RUNBOOK](./RUNBOOK.md) §1。

## 3. 门禁

- `kore-plugins/scripts/validate-index.sh`：schema、`id@version` 唯一、版本单调递增、同版本 sha 锁定、签名。
- `index/versions.lock.json` 是发版账本（非信任源）：索引版本/sha 必须等于账本最新记录；改包不 bump 直接 FAIL。
- 漏 bump 的修复只能「新版本 + 新 release」，**禁止**覆盖同版本 release 资产。
