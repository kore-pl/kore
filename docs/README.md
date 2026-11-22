> 状态: draft · 归属: lead · 更新: 2026-11-22 · 里程碑: M5

# docs — kore 文档总览

本目录是 kore 的文档中枢，覆盖愿景、架构、内核协议、资源与数据、前端安全、治理开源与历次架构决策（ADR）。全部文档为纯 Markdown，零构建依赖、断网可读。

> 📄 **静态文档站**：打开 [site/index.html](./site/index.html) 可按分类浏览与搜索全部文档（`file://` 双击即开，零框架、零外链、零 fetch；索引文件 `site/docs.js` 由 `bash docs/site/build-index.sh` 生成）。

## 1. 文档地图

### 1.1 愿景与设计

| 文档 | 作用 |
| --- | --- |
| [VISION.md](./VISION.md) | 项目愿景与边界：做什么、不做什么、五锚点与成功判据 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 组件图、进程模型、插件状态机、故障域 |
| [V1-GOALS.md](./V1-GOALS.md) | v1.0 目标书：22 项能力域与深度分级 |
| [PLAN.md](./PLAN.md) | 执行计划与里程碑拆解 |
| [ROADMAP.md](./ROADMAP.md) | 路线图：M0 至 v1.0 的推进节奏 |
| [SCENARIOS.md](./SCENARIOS.md) | 场景预设与首次安装体验 |
| [MILESTONE-M0.md](./MILESTONE-M0.md) | M0「文档与骨架」交付清单与验收标准 |
| [MILESTONE-M1.md](./MILESTONE-M1.md) | M1「行走骨架」交付清单与验收标准 |
| [FEATURE-PARITY.md](./FEATURE-PARITY.md) | 对标宝塔 / 1Panel 专业版的能力矩阵 |
| [PARITY-GAP.md](./PARITY-GAP.md) | 现状 vs 目标的可执行差距账 |
| [GLOSSARY.md](./GLOSSARY.md) | 术语表与命名约定 |
| [PLUGIN-CATALOG.md](./PLUGIN-CATALOG.md) | 插件目录与生命周期配额 |

### 1.2 内核与协议

| 文档 | 作用 |
| --- | --- |
| [CORE.md](./CORE.md) | 内核规格：九个模块 + 支撑小节、HTTP 端点与边界 |
| [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md) | 插件协议 `kore.plugin.v1` 唯一来源：帧格式 / 握手 / 方法 / 事件 / 错误码 |
| [REPOS.md](./REPOS.md) | 多仓库拓扑（N+2）与跨仓库规则 |

> 说明：`PLUGIN-SDK.md` 尚未落盘；插件公开 SDK 的接口契约暂以 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md) 为准。

### 1.3 资源与数据

| 文档 | 作用 |
| --- | --- |
| [RESOURCE-MODEL.md](./RESOURCE-MODEL.md) | 资源预算、cgroup v2 隔离、度量口径与 CI 判定 |
| [DATA-MODEL.md](./DATA-MODEL.md) | 配置 / 状态 / 日志三类持久数据的字段与落盘格式 |
| [COMPATIBILITY.md](./COMPATIBILITY.md) | 三平台兼容基线（Linux GA / Windows / macOS preview） |

### 1.4 前端与安全

| 文档 | 作用 |
| --- | --- |
| [FRONTEND.md](./FRONTEND.md) | 主壳前端信息架构、设计令牌、插件前端契约与性能底线 |
| [SECURITY.md](./SECURITY.md) | 威胁模型、鉴权授权、插件隔离、密钥与升级链 |

> 根 [SECURITY.md](../SECURITY.md) 是安全披露政策，本文 `docs/SECURITY.md` 是安全设计，二者不要混。

### 1.5 治理与开源

| 文档 | 作用 |
| --- | --- |
| [OPEN-SOURCE.md](./OPEN-SOURCE.md) | MIT 许可、版权人、PR / Issue 流程与评审要求 |

### 1.6 决策 ADR

[DECISIONS/](./DECISIONS/) 目录收录全部架构决策记录，编号 0001–0017，覆盖协议选型、进程隔离、资源预算、多仓拓扑、兼容基线等不可逆选择。每篇含备选对比、后果与复审条件。可通过[文档站](./site/index.html)的「决策 ADR」分类统一浏览。

## 2. 阅读顺序

1. 先读 [VISION.md](./VISION.md) 建立「为什么做 / 不做什么」的边界感。
2. 再读 [ARCHITECTURE.md](./ARCHITECTURE.md) 理解组件、进程与故障域。
3. 按角色深入本领域：内核 [CORE.md](./CORE.md)、协议 [PLUGIN-PROTOCOL.md](./PLUGIN-PROTOCOL.md)、资源 [RESOURCE-MODEL.md](./RESOURCE-MODEL.md)、数据 [DATA-MODEL.md](./DATA-MODEL.md)、前端 [FRONTEND.md](./FRONTEND.md)、安全 [SECURITY.md](./SECURITY.md)。
4. 遇到「为什么这样定」的问题，查 [DECISIONS/](./DECISIONS/) 对应 ADR，不重复争论已裁决事项。
5. 治理与贡献流程见根 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [OPEN-SOURCE.md](./OPEN-SOURCE.md)。

## 3. 维护约定

- 改动路径 / 协议 / 预算数字 / 角色名，必须在同一检查点同步对应文档，并过 `make docs-check`。
- 每份文档前 5 行须含 `> 状态:` 与 `里程碑: Mx` 元信息，否则 docs-check 阻断。
- 新增顶层文档后，运行 `bash docs/site/build-index.sh` 重建静态索引；新文档若在分类映射之外会打印 WARN 并归入默认分类，需同步补 `build-index.sh` 的 `CATEGORY` 字典。
- 关键口径（如 `8 MiB`、`kore.plugin.v1`、`/run/kore`）至少在两份文档出现，供 docs-check 覆盖性校验。

## 4. 文档站（M5-B）

[site/index.html](./site/index.html) 是一个零依赖静态索引：

- **断网可开**：`file://` 直接双击打开，不用启动任何服务器。
- **零外链**：无 CDN、无 `http(s)` 请求、无框架、无 node 运行时。
- **生成方式**：`bash docs/site/build-index.sh` 用 python3 标准库扫描 `docs/*.md` 与 `docs/DECISIONS/*.md`，输出 `site/docs.js`（内嵌 `window.KORE_DOCS`）；首页原生 JS 渲染分类列表并支持搜索过滤。
- **不入库 markdown**：`site/` 下刻意不放任何 `.md`，避免被 docs-check 的递归元信息扫描误判。

### 4.1 目录结构

```
docs/site/
├── index.html       # 静态首页：分类列表 + 搜索框（原生 JS）
├── docs.js          # 生成物：window.KORE_DOCS = [{title, path, category, status}, ...]
└── build-index.sh   # 生成器：python3 标准库，零第三方依赖
```

三个文件的职责严格分离：`build-index.sh` 只读扫描并写 `docs.js`，`index.html` 只读 `docs.js` 并渲染，二者之间没有任何运行时耦合到 python——生成完成后整个目录就是纯静态资源。

### 4.2 重建步骤

```bash
bash docs/site/build-index.sh   # 退出码 0 即成功，stdout 打印条数与分类数
```

生成器对每篇文档读取两类信息：首个 `# ` 开头的标题行作为 `title`，前 5 行的 `> 状态:` 取第一段作为 `status`。路径一律从 `docs/site/` 出发写成 `../XXX.md`，保证 `file://` 双击首页即可跳转。输出按「分类优先级 → 路径」稳定排序，同一批文档重复生成字节完全一致（可安全入库 diff）。

### 4.3 断网验证方式

```bash
# 1) 零外链：docs/site/ 下不得出现 http(s) 引用
grep -rnE 'https?://' docs/site/    # 应无匹配

# 2) 内嵌 JSON 可解析：正则提取 window.KORE_DOCS 赋值后 json.loads
python3 -c "import re,json,pathlib; s=pathlib.Path('docs/site/docs.js').read_text(); \
d=json.loads(re.search(r'window\\.KORE_DOCS\\s*=\\s*(\\[.*\\])\\s*;\\s*\$', s, re.S).group(1)); print(len(d))"

# 3) 相对链接可达：逐条 (docs/site/ + path) 检查 exists()
# 4) 断网打开：断网或将 URL 协议改为 file:// 双击 index.html，分类列表与搜索均正常
```

以上四项与「`bash docs/site/build-index.sh` 退出码 0」共同构成本目录的验收闭环，任一不过即为未完成。

### 4.4 新增文档时的维护动作

顶层新增 `.md` 后需把文件名加入 `build-index.sh` 的 `CATEGORY` 字典；否则生成器会打印 `WARN 未映射文档` 并归入默认类「愿景与设计」，虽不阻断但分类不再准确。`README.md` 作为导航页自身被显式排除，不出现在文档条目中。决策 ADR 由 `docs/DECISIONS/*.md` 全量自动收录，无需手工登记。
