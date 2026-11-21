# 任务卡：<动词开头的标题>

> 状态: draft · 归属: scribe · 更新: 2026-11-21 · 里程碑: M0

## 基本字段

| 字段 | 值 |
| --- | --- |
| id | `<里程碑>-<轨道>` |
| subject | <一句话标题，能独立看懂> |
| owner | <lead / architect / implementer / verifier / red-team / scribe> |
| status | pending |
| write_scopes | `<path/a>`, `<path/b>`（同层写域不得与他人重叠） |
| blocked_by | <任务 id 列表，无依赖写 —> |
| revision | 1 |

## 依赖与前置

- <哪个任务完成后才能开工；无则写"无">

## 验收命令（原本，不许改参数）

```bash
make docs-check ; echo "exit=$?"
```

## evidence（交付时回填）

```text
命令: <原样命令，含环境变量与参数>
退出码: <0>
输出: <关键输出 3 行；文档类任务贴文件清单 + wc -l>
```

## 完成判定

- [ ] 验收命令全部退出码 0
- [ ] 改动文件与 write_scopes 一致，无写域外改动
- [ ] 跑不了的门禁写 N/A + 原因，不写成 PASS
- [ ] 蓝军问题单已签收（无则写"无"）；evidence 已回填且能被他人复现
