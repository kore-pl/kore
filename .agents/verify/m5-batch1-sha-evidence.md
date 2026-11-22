# meta: kind=evidence task=m5-batch1-sha date=2026-11-22 owner=scribe-m5-sha milestone=M5 repo=kore role=scribe

# M5 批1 · 第六次重签 dist sha256 输入清单

> 本文件仅登记 lead 已用 `sha256sum` 独立核验的真实 dist 包摘要，不采信 agent 自报；未出包与未提交项如实留白，不补估计值。

## 一、八仓清单

| 插件 id | 深度 | dist 完整 sha256 | 核验来源 | commit hash |
| --- | --- | --- | --- | --- |
| file | production | `45078bdfcca8695288b66315c8b7e9ccc592eb8473b6e6b331e02a71036c7ffc` | lead sha256sum 独立核验 | b4997c3 |
| ssl | production | `891adc5affcad5efda41b68f5ee8f21d59867e32c10b4de10a74e80e53ea8453` | lead sha256sum 独立核验 | fa12754 |
| integrity | basic | `5aa02fc01d242dcad73e655dd11f7272c4ef96227073b9aeceadc7a85578400d` | lead sha256sum 独立核验 | a0b789b |
| cron | production | `ef0344b3f418722c6eac5871efeef822ace5154b165765111fc04b74e2ba2634` | lead sha256sum 独立核验 | 21a3145 |
| ssh-guard | basic | `bdb91b2d4415cac435fe7422321accdc2b70cca7645fd12802252617a85dc0f7` | lead sha256sum 独立核验 | da20463 |
| monitor | production | `19909d5e1c914f953a48c1bc1b93d8dbc1a40e39ee2c24435185cbd62757024c` | lead sha256sum 独立核验（工作树 + git archive HEAD 洁净复建两处一致 PASS，tar 首条目 info.json） | d2661354e34a9cb12868860b727429923db3df19 |
| logs | production | `8ff57a55e7028f2e6bd565af48b4c427f492a800b53afa69e75838530bf3cd47` | lead sha256sum 独立核验 + tar 首条目 info.json | ddf37725c6bcfe64a7fff85a95b55a6c054e8e5b（该仓分支为 master 非 main，已记遗留） |
| dns | basic | `f56fb7c3d62acf3fcf344076f3e2efd03601ca201c593c0a1d0bc9ffe02fc0bd` | lead sha256sum 独立核验 + tar 首条目 info.json | `e34fc257df0670d8b7d916b92f9c7f403bef6dba`（两次提交，含 test(fault) 修干净 clone） |

## 二、口径

本表为第六次重签的输入清单，sha 必须由 lead 用 `sha256sum` 对真实 dist 包独立核验，不采信 agent 自报；每仓 tar 首条目须为 `info.json`，已核 file / ssl / integrity / cron / ssh-guard / monitor 六仓均 PASS。sha 必须在插件仓 commit 完成后核验，未提交 / 迭代中的 dist 是中间态，不得作为重签输入（本次 monitor 踩过：提交前中间态 sha `24ea4c81…` 已作废）。

## 三、待办

- 批1 八仓齐备、第六次重签完成（索引 10 插件、公钥 f271723a…）。
