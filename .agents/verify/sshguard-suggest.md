# G-28 双端证据：SSH 防护 · 加固建议（suggest）

> 视图：`web/sshguard.js`（提交 `7711cba`）｜插件：`ssh-guard` 0.3.0（dist `a392b063…`，2840608 B）
> 场景：SSH 防护页第 5 个面板「加固建议」——只读生成建议配置 + 差异 + 风险（含回滚）+ 可复制命令，**无「一键应用」**。

## 环境（隔离实例，不碰主实例）

- 独立 `kored`：`127.0.0.1:18882`（用前 `ss -ltn` 确认空闲），配置 / state / run / log 全在 `/tmp/kore-g28/`；
- 索引只读指向主仓 `kore-plugins/index`（不复制、不重签）；
- 安装路径：`POST /api/v1/store/install {"id":"ssh-guard","version":"0.3.0","package_path":"…/dist/ssh-guard-0.3.0.tar.gz"}` → `state=succeeded, reload=reloaded`（走安装器校验/解包/登记，再 `POST /plugins/ssh-guard/enable`）；
- 截图：Playwright 1.65（缓存 chromium-1248 headless）+ 登录会话，PC viewport 1440×900 / 手机 390×844，`fullPage`；
- **主实例零写入**：未改主配置 / 主 state / `bin/kored`，未重启 8787；临时实例已清理（18882 已关闭）。

## 截图与 `file` 复核

| # | 文件 | file 输出 | 说明 |
|---|------|-----------|------|
| ① | `sshguard-suggest-desktop-01-initial.png` | PNG 1440 x 1551 | 加固建议初始态：两个开关 + 端口（留空=保持当前）+ 最大认证次数（6）+ 只读说明，无「一键应用」 |
| ② | `sshguard-suggest-desktop-02-generated.png` | PNG 1440 x 2933 | 勾选「关闭密码认证」+ 端口 2222 → 生成结果：建议配置 `<pre>`、`diff_from_current`（PasswordAuthentication/Port/MaxAuthTries 逐条「(未设置) → 建议值」）、风险与命令 |
| ③ | `sshguard-suggest-desktop-03-risk.png` | PNG 1054 x 80 | 风险卡元素截图（PC 1440 视口）：high 红边 + 「高危 port_change」+ 最后一行「回滚：…」 |
| ④ | `sshguard-suggest-mobile-01.png` | PNG 390 x 4007 | 手机 390×844 同区块：单列堆叠、按钮 44px、`<pre>` 可滚动、风险与回滚可见 |

> ② 的 diff 三项均显示「(未设置) → 建议值」：隔离容器的 `/etc/ssh/sshd_config` 存在但当前会话读不到（后端给 `path_hint`，同时 `diff_from_current` 仍按「未设置」对比），属预期数据形态，不是前端编造。

## 产品定位自评（三问）

1. **解决什么用户问题**：想收紧 sshd（禁密码 / 禁 root / 换端口 / 降尝试次数）但怕改坏、怕把自己锁在门外。页面把「建议配置 + 当前值差异 + 每条风险的回滚步骤 + 可整段复制的命令」一次给全，先看后做，失败有退路。
2. **与宝塔 / 1Panel 的差距**：宝塔/1Panel 的 SSH 安全多是「开关直接写配置 + 一键生效」，路径短但少解释、少回滚提示；本页不自动下发（后端确实没有受控写原语），因此少了「一键应用」这一步，多了 diff / 风险分级 / 回滚 / 验证命令。差距在「最后一步自动化」，不在可解释性。
3. **可用还是占位**：**可用（建议态）**。生成、差异、风险、复制、验证均真实可用；真机一键下发待 v1.1（需 ADR-0022 增补受控写原语，见插件 README），页面已明确标注且无假按钮。

## 顺带记录的产品缺口（不改代码，供另开工单）

1. `kored serve` 启动时会跳过「插件目录存在但状态库未登记」的插件（日志：`插件目录存在但状态库未登记，跳过`）——手工解包到 `state/plugins/<id>/<ver>` 不会被识别。
2. `kored install` 在 M1 只解析 `--package/--scenario` 参数、不落库；离线安装目前只能走 `POST /api/v1/store/install {package_path}` 这一条窄路径。
