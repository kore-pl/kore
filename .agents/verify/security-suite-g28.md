# security-suite · G-28 双端证据与自评

- owner: feat-security-suite
- 实例：隔离实例 127.0.0.1:18891（config/state/run/log 全在 kore/.tmp-security-iso/，未改主实例 8787 运行态资产，G-29 合规）
- 截图：`screenshots/security-suite-desktop-01.png`（1440×900）、`screenshots/security-suite-mobile-01.png`（390×844）；`file` 实测宽高合规、sha256 各异（259c99a1… / 93dc6a50…）。
- 画面：设置 → 安全 tab，真实登录后渲染；三张卡片（两步验证 / 登录网络限制 / API 令牌）均来自隔离实例真实 API（token 列表可见 ci-demo）。

## 产品定位自评（三问）

1. **解决什么用户问题**：宝塔 / 1Panel 标配的三项登录与自动化安全能力（2FA、登录来源 IP 限制、可撤销 API token）此前 Kore 内核 grep 为 0（`docs/PARITY-GAP.md:82` / `docs/FEATURE-PARITY.md:82-83` 明确列为待补）。本页让单管理员在「设置 → 安全」一处完成配置，不必改配置文件、不必重启 kored。
2. **与宝塔 / 1Panel 的差距**：三项能力均可用且默认关闭、不破坏现有登录流程；差距是 TOTP 仅支持认证器 App（无短信/邮件）、恢复码固定 10 个不可自定义、IP 白名单只按 CIDR 不按地理位置、API token 只有 read/admin 两档 scope——这些属于单管理员薄壳模型的刻意边界，非占位。
3. **可用还是占位**：**可用**。三件事都真跑通：2FA 开启后登录缺 OTP 返回 428、恢复码/动态码登录 200；IP 白名单开启后非网段来源登录 403 E_IP_DENIED；API token 生成后 Bearer GET 200、read scope 写操作 403、吊销后 401。默认关闭时登录流程与改动前完全一致。
