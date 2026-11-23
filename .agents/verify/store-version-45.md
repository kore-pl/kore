[agent:kore-verify-privilege]

# 第 45 把「索引 → 商店 API」链路验证（隔离实例，补 43/44/45 三把的未验证缺口）

- 日期：2026-11-23 21:10+08:00 · 执行：kore-verify-privilege · 任务 task-177
- 目的：三把重签后 `GET /api/v1/store/plugins` 都因「无管理员会话」标为未验证。本文件用**隔离实例**证明「同一份 kore-plugins/index → 商店 API」链路本身通。
- 边界：**主实例 8787 的商店版本仍未验证**（无会话、未改用户口令）；本文件只证链路，不证主实例。

## 1. 隔离实例（portable，不碰主实例）

```text
目录：/tmp/kore-store45/{state,run,log}
端口：127.0.0.1:18896
配置（/tmp 内，未写主配置）：
  server.addr = 127.0.0.1:18896
  auth.admin_password_hash = pbkdf2-sha256$600000$<base64 salt>$<base64 key>（手工 PBKDF2 路径生成）
  auth.session_ttl = 30m，cookie_secure = false
  paths.state_dir / run_dir / log_dir 全部在 /tmp/kore-store45
  paths.index_dir = /home/pt/Work/GolandProjects/kore-plugins/index（**只读指向 main 索引，未复制未重签**）
启动：systemd-run --user --unit=kore-store45 --collect --setenv=KORE_HOME=/tmp/kore-store45 … bin/kored serve --config /tmp/kore-store45/config.yaml
健康：GET http://127.0.0.1:18896/-/healthz → 200
```

## 2. 登录（隔离实例自己的口令）

```text
POST /api/v1/auth/login {"password":"<隔离实例口令>"}
→ HTTP 200 {"authenticated":true,"expires_at":"2026-11-23T13:39:22Z"}
（该口令与哈希仅存在于 /tmp，已随清理删除；与主实例口令无关）
```

## 3. 商店 API ↔ 索引文件逐字比对

`GET /api/v1/store/plugins` → HTTP 200，24 条；索引文件 `plugins.json` 24 条。

| 插件 | API version | API sha256 | API size | 索引 version | 索引 sha256 | 索引 size | 一致 |
|---|---|---|---|---|---|---|---|
| waf | 0.4.1 | `201635abc29baaaa932d16723ed9b7a6a2c3b87477341772abc06bbf8137621d` | 2934045 | 0.4.1 | 同左 | 2934045 | ✅ |
| runtime-python | 0.3.1 | `f16abf6e6644f3626a55b85a6c27bfd37d3da9d9c3e2a871236dff80ac1f99f0` | 1550361 | 0.3.1 | 同左 | 1550361 | ✅ |
| container | 0.5.1 | `8d1b586b05fe8a2e3e9ada77dc34cdd56975cdb6004436b85ea8c2efdceb7279` | 1527626 | 0.5.1 | 同左 | 1527626 | ✅ |

```text
三条的 match_version / match_sha / match_size 均为 True
api_count=24 == idx_count=24
```

## 4. index_dir

```text
GET /api/v1/system/info → paths.index_dir = /home/pt/Work/GolandProjects/kore-plugins/index
（与主实例配置指向同一份索引，只读引用；隔离实例自身 state/run/log 全在 /tmp）
```

## 5. 清理与主实例零影响

```text
systemctl --user stop kore-store45 → inactive
ss -ltnp '( sport = :18896 )'     → 0（端口已释放）
rm -rf /tmp/kore-store45          → 已删除（含临时口令哈希）
主实例：pid=1610096 未变；healthz=200；cgroup=…/kored-local.service（未被触碰）
主实例运行态写入：0（未改 .kore-local.yaml / state / 口令哈希 / 索引）
```

## 6. 结论与边界

- **链路已证**：main 分支的 `kore-plugins/index` 被商店 API 逐字读出（3 条新版本 version/sha/size 全等，24/24 条一致，index_dir 正确）。
- **主实例 8787 仍未验证**：无管理员会话，且按 G-29 不碰用户口令。若将来要验主实例，正确做法是用户本人登录后查看，或另设一次性只读 token（需 ADR）；不得为验收改口令。
