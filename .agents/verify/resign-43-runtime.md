# 第 43 把重签 · 运行时商店证据（task-140）

- 时间：2026-11-23 20:35 (+08:00)
- 范围：主实例 `127.0.0.1:8787`（`.kore-local.yaml`），只读验证。
- 登录方式：复用本机既有的已登录会话 cookie jar（`/tmp/c2.txt`，本机文件，未外发、口令未落盘/未写入本文件）。
- 本轮未改配置、未重启 kored、未安装/升级任何插件（G-29：无运行态写操作）。

## 1. 索引目录（G-29）

```text
GET /api/v1/system/info → paths.index_dir
/home/pt/Work/GolandProjects/kore-plugins/index
```

与配置一致，非 signed-index 快照。

## 2. 主实例进程

```text
$ pgrep -af 'kored serve'
608004 /home/pt/Work/GolandProjects/kore/bin/kored serve --config /home/pt/Work/GolandProjects/kore/.kore-local.yaml
$ ps -o pid=,etimes= -p 608004
 608004    1069
```

pid 仍为 **608004**（第 43 把期间未重启），etimes 1069s。

## 3. 商店 24 条 vs 索引（重点 7 条）

`GET /api/v1/store/plugins` 返回 24 条；`../kore-plugins/index/plugins.json` 24 条；
逐条比对 `id / version / sha256` → **mismatch = {}**（24/24 一致）。

| 插件 | 索引版本 | 商店版本 | 商店 sha256（前 12） | 一致 |
| --- | --- | --- | --- | --- |
| app-deploy | 0.3.0 | 0.3.0 | `f3fdb914f01a` | ✅ |
| ssl | 0.6.0 | 0.6.0 | `832a06ebcb56` | ✅ |
| cron | 0.5.0 | 0.5.0 | `25a7f55886cf` | ✅ |
| integrity | 0.4.0 | 0.4.0 | `4358320e002a` | ✅ |
| logs | 0.5.0 | 0.5.0 | `d34bf34dba28` | ✅ |
| dns | 0.4.0 | 0.4.0 | `4010651b6e92` | ✅ |
| redis | 0.6.0 | 0.6.0 | `3088ef0ee718` | ✅ |

结论：第 43 把重签后的 **7 条新版本已被运行中的商店真实看到**；24 条全量 `mismatch={}`。

## 4. 命令留档

```bash
curl -s -b /tmp/c2.txt 127.0.0.1:8787/api/v1/store/plugins        # 200，24 条
curl -s -b /tmp/c2.txt 127.0.0.1:8787/api/v1/system/info          # 200，index_dir 如上
pgrep -af 'kored serve'                                           # 主实例 pid 608004
python3 比对 store vs index（id/version/sha256）                   # mismatch={}
```

无差异，无需修正；未触发“停下贴差异”分支。
