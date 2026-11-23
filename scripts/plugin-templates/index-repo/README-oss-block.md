<!-- oss:begin -->
## 开源与贡献

[![CI](https://github.com/kore-pl/{{REPO}}/actions/workflows/ci.yml/badge.svg)](https://github.com/kore-pl/{{REPO}}/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go 1.26](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go&logoColor=white)](go.mod)

本仓库是 **kore** 的插件索引仓（`{{REPO}}`）：纯静态 `index/plugins.json` + 校验脚本，**不审核、不代管包、无账号、无上传接口**。包体由各插件仓 `make dist` 产出并挂在它们自己的 release 上，这里只记录 `download_url` / `size_bytes` / `sha256`。CI 只在 push main / tag / PR / 手动触发；校验以本地 `make check` 为准。

- **许可**：MIT（inbound = outbound，不要求 CLA）；提交用 `git commit -s` 签 DCO。
- **贡献**：[CONTRIBUTING.md](CONTRIBUTING.md)（索引条目、版本账本、预设、签名、校验）。
- **安全**：[SECURITY.md](SECURITY.md)——索引篡改 / 签名 / 供应链问题不要开公开 issue。
- **行为准则**：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- **索引 schema**：`schema_version=1`；`plugins[]` 每条必填 `id` / `name` / `version` / `depth_level` / `lifecycle` / `size_bytes` / `sha256` / `download_url` / `requires_kore` / `depends_on` / `conflicts` / `scenario_tags`。同一 `id@version` 只允许一个 sha（`index/versions.lock.json` 对账）。
- **校验**：本地 `make check` → `scripts/validate-presets.sh` + `scripts/validate-index.sh`（含 ed25519 验签；CI 少触发，以本地为准）。
- **相关仓库**：[kore](https://github.com/kore-pl/kore) · [协议文档](https://github.com/kore-pl/kore/blob/main/docs/PLUGIN-PROTOCOL.md) · [SDK 指南](https://github.com/kore-pl/kore/blob/main/docs/PLUGIN-SDK.md)

<!-- oss:end -->
