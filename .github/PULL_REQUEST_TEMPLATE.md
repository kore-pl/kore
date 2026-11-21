## 变更说明

<!-- 做了什么、为什么做；一句话能说清就别写三段。 -->

## 影响面

- [ ] 内核 / 主壳（`internal/`、`cmd/`）
- [ ] 公开 SDK / 协议（`pkg/pluginapi`）
- [ ] 文档（`docs/`、根文档）
- [ ] 构建 / CI / 门禁（`Makefile`、`scripts/`、`.github/`）
- [ ] 其它：

## make check 输出

<!-- 必须贴 9 段结果（含 oss-check、case-check），并注明退出码。未跑或未过请说明原因。 -->

```text
$ make check
（粘贴输出）
```

## 关联 issue

<!-- 如 Closes #123；没有就写"无"。 -->

Closes #

## 是否修改协议或数据格式

- [ ] 否
- [ ] 是 → **必须附 ADR**（`docs/DECISIONS/`），说明兼容性、版本影响与迁移方式

> 改了协议/数据格式却没有 ADR 的 PR 不予合并（G-14 / G-06）。
