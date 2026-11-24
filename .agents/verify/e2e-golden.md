# R21 黄金用户旅程 E2E：新用户从零到「真实 curl 200」五步链

日期：2026-11-24 18:13–18:15（Asia/Shanghai）｜Owner：`r21-golden`（🔵 美团味）｜隔离端口：kored **18885** / nginx 站点 **18090**｜HEAD：`6e0529a06be3605fd2ad2e45be0ba47747dca7f8`（执行启动时 `git rev-parse HEAD` 实测；会话早段基线为 `bc9b237f`，并发 agent 期间推进，本报告 archive 用的是启动时真实 HEAD）

> ▎[🔵 美团味] 做难而正确的事——前面的人只返回 `access_url` 字符串就收工，我把 curl 真发出去，拿到 200 + HTML body + `Server: nginx/1.31.9` 响应头。过程透明、结果说话，拿接口 200 / access_url 字符串冒充访问成功 = 3.25。

## 0. 结论先行

**五步链端到端真跑通，核心硬指标「真实 curl 200」首次取证成功。**

- **核心证据**：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18090/` → **`200`**，并附 HTML body（`<title>kore app-deploy</title>`）与 `HTTP/1.1 200 OK / Server: nginx/1.31.9` 响应头。这是 r21-strategy 基线明确标注「从未取证」的最后一步，本轮首次用真实 HTTP 请求坐实。
- 五步判定：**装插件 PASS / 装运行时 跳过（环境不需要，如实标注） / 建站 PASS（真起 nginx 容器） / 签证书 环境替代（自签，非 ACME） / curl 访问 PASS（真实 200）**。
- 硬卡点绕开：`site@0.4.4` 缺 PHP 三方法（来源为 r20-e2e-content **会话产出**，非独立报告）不影响本链——nginx-static 纯静态模板不调 `site.setPHP`，无需 runtime-php/node，无需域名，最短路径直达 curl 200。
- 全程 **8787 主实例零改动**：healthz 200、PID 2128919 未变、二进制 mtime / 配置 `index_dir` 未变；临时资产（隔离目录 / 容器 / 卷 / 口令 / cookie jar / 脚本）全部清理，git status 中无本轮产物残留。

## 1. 开工前必读与基线（逐条对齐）

| 材料 | 关键口径 | 本轮落实 |
| --- | --- | --- |
| AGENTS G-29 | 运行态写边界；测不同必须起隔离实例（独立 config + state/run/log 落 /tmp） | `git archive` HEAD → `/tmp/kore-r21-golden/src` 独立构建 + 独立 config/state/run/log + 端口 18885，8787 零触碰 |
| AGENTS G-30 | `.agents/verify/` 不得出现明文口令，占位仅 `***` | 口令仅存在于内存变量与 0600 隔离 seed；本报告全程 `***`；`make secret-check` = 0 FAIL |
| RUNBOOK §1/§8 | 隔离实例构建、公钥两副本一致、索引验签 | 复用隔离口径（archive + admin-password + healthz 就绪）；索引指向真源 `/home/pt/Work/GolandProjects/kore-plugins/index`，未重签、未改主配置 |
| r20-e2e-deploy 报告（`.agents/verify/e2e-deploy-write.md`） | login / install / enable / deploy 链路已真跑通；`nginx-static` 默认 HTTP 18090、绑回环、自带 index.html | 完整复用其链路；本轮新增的是**对 access_url 真发 curl 并记 200 + body**（报告 §6「未证明」项） |
| r20-e2e-content 双版本发现（**会话产出**，见 HANDOFF §0.0.10） | `site@0.4.4` dist 无 `setPHP`/`getPHP`/`unsetPHP`；纯静态路径在 0.4.4 也支持 | 走 app-deploy nginx-static 纯静态模板绕开 PHP；如实标注该发现为横向交流、非本轮亲测 |
| r21-strategy 基线（**会话产出**，落 `.agents/HANDOFF.md` §0.0.10） | 「黄金旅程最后一步真实 curl 200 从未取证：e2e-deploy 只返回 access_url，没有真发 curl 记 200 + body」 | 本轮核心就是补这个缺口，见 §3 STEP5 |
| r19-shots2 CSRF 经验 | 写请求（install/enable/invoke/remove）必须带 `X-Kore-CSRF` == `kore_csrf` cookie | 全部写请求带双提交头，无一 401 |

## 2. 环境与前置基线（命令 + 退出码 + 输出）

```text
$ git -C /home/pt/Work/GolandProjects/kore rev-parse HEAD
6e0529a06be3605fd2ad2e45be0ba47747dca7f8        # 执行启动时真实 HEAD

$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/-/healthz
200                                               # 主实例健康（只读探测）
$ pgrep -f '/kore/bin/kored serve --config' | head -1
2128919                                           # 主实例 PID，全程未变
$ grep index_dir .kore-local.yaml
  index_dir: "/home/pt/Work/GolandProjects/kore-plugins/index"   # 字面正确，未改
$ stat -c '%y %s' bin/kored
2026-11-24 17:41:45.358780824 +0800 11190434      # 主二进制 mtime/size 未变

$ docker version --format '{{.Server.Version}}'  → 29.7.2
$ docker image inspect nginx:alpine --format '{{.Id}}' → sha256:fb4658584bd9a...（本地已有）
$ ss -ltn | grep -E ':18885 |:18090 ' → 0 命中（两端口空闲）
```

**隔离实例构建**（全在单次 bash 调用内完成，因本机 /tmp 跨调用不持久、kored 需跨 curl 存活）：

```text
$ git archive <HEAD> | tar -x -C /tmp/kore-r21-golden/src          → exit=0
$ cd src && make web-dist                                          → exit=0
$ CGO_ENABLED=0 GOAMD64=v1 GOWORK=off go build \
    -trimpath -buildvcs=false -ldflags '-s -w' -o bin/kored ./cmd/kored  → exit=0
$ sha256sum bin/kored
5e6012c54b802847f7d9d2759eac32d255e2d84e7ac39286881ef035aabd4763   # 11190434 B，独立产物
$ kored admin-password --set --stdin --config config.yaml          → exit=0（0600，口令 *** 占位）
$ KORE_SSL_CERT_DIR=<root>/state/ssl kored serve --config config.yaml &
  kored_pid=2232503
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18885/-/healthz → 200
$ curl http://127.0.0.1:18885/api/v1/system/info → paths=<none>  # 本版本响应体不含 paths.index_dir，
                                                                   # 与 r20 系列同口径：以主配置字面 + PID/mtime 坐实 G-29

$ curl -c cookie.jar -H 'Content-Type: application/json' \
    -d '{"password":"***"}' http://127.0.0.1:18885/api/v1/auth/login
HTTP=200  {"authenticated":true,"expires_at":"2026-11-24T12:14:40Z"}
csrf_len=43
```

> 说明：口令在请求体以 stdin 传入、不进 argv、不回显；报告与 stdout 全程 `***`。

## 3. 五步链逐条证据（命令 + 退出码 + JSON + 判定）

### STEP 1 · 装插件 `site@0.4.4` + `app-deploy@0.3.3` —— **通过**

```text
$ sha256sum site-0.4.4.tar.gz       → c91ddced481d7bcc8df1880446af7b2a190a5df0c5ee50a6fb9e32265093431e  (= 索引)
$ sha256sum app-deploy-0.3.3.tar.gz → 3253c1a72a9ec098f985e97f8b8a3d128508f5dc328e4b6fcd9f212c55bbcb39  (= 索引)

$ curl -b cookie.jar -H 'Content-Type: application/json' -H "X-Kore-CSRF: $CSRF" \
    -d '{"id":"site","version":"0.4.4","package_path":"<site-0.4.4.tar.gz>","force":true}' \
    .../api/v1/store/install
HTTP=200  {"id":"site-0.4.4","plugin_id":"site","version":"0.4.4","state":"succeeded","message":"安装完成","reload":"reloaded"}

$ curl ... -d '{"id":"app-deploy","version":"0.3.3","package_path":"<app-deploy-0.3.3.tar.gz>","force":true}' .../store/install
HTTP=200  {"id":"app-deploy-0.3.3","plugin_id":"app-deploy","version":"0.3.3","state":"succeeded","message":"安装完成","reload":"reloaded"}

$ curl ... -d '{}' .../api/v1/plugins/app-deploy/enable
HTTP=200  {"id":"app-deploy","version":"0.3.3","enabled":true,"desired":"enabled",
           "method_capabilities":{"app-deploy.deploy":"system:admin","app-deploy.templates":"system:read",...}}
```

判定：**通过**。两个插件本地包装装（sha 与索引逐字节一致）+ enable 成功；全程 CSRF 双提交，无 401。

### STEP 2 · 装运行时 —— **跳过（如实标注：本链环境不需要）**

```text
判定依据：nginx-static 模板使用 nginx:alpine 容器自带 web server，容器 80 → 宿主机 127.0.0.1:18090；
         deploy 全程不调用 site.setPHP / getPHP / unsetPHP，也不调用 runtime-php / runtime-node。
结论：纯静态站点路径无需独立 runtime 插件，本步跳过；未安装 runtime-* 任何插件。
```

判定：**跳过（合理）**。不是遗漏——纯静态站点由容器自带 web server 承载，装 runtime 插件对本链无意义，反而增加清理面。

### STEP 3 · 建站 / 部署 `nginx-static` 真起容器 —— **通过**

```text
$ curl ... -d '{}' .../invoke/app-deploy/app-deploy.templates
HTTP=200  {"templates":[{"id":"nginx-static","name":"Nginx 静态站点","image":"nginx:alpine",
           "ports":[{"container_port":80,"default_host_port":18090,"access_prefix":"http://"}],...}],"count":4}

$ curl ... -d '{"template":"nginx-static","name":"kore-app-golden","ports":[],"env":{},"volumes":[]}' \
    .../invoke/app-deploy/app-deploy.deploy
HTTP=200
{"deployed":true,"id":"0141ea6a4448c76c","template":"nginx-static","name":"kore-app-golden",
 "container_id":"3f57132cd3b0ba64376070322f8433ef4c05eaf0cc6486aa5dc37e20c0b6100f",
 "access_url":"http://127.0.0.1:18090/",
 "ports":[{"service":"web","container_port":80,"host_port":18090,"access_url":"http://127.0.0.1:18090/"}],
 "containers":[{"service":"web","name":"kore-app-golden","id":"3f57132c..."}],
 "created_at":"2026-11-24T10:14:40Z"}

$ docker ps --filter name=kore-app-golden --format '{{.Names}} {{.Status}} {{.Ports}}'
kore-app-golden Up Less than a second 127.0.0.1:18090->80/tcp        ← 真容器
$ ss -ltn | grep ':18090 '
LISTEN 0 4096 127.0.0.1:18090 0.0.0.0:*                             ← 真监听
```

判定：**通过**。deploy 真拉起 nginx 容器并绑定回环 18090（非接口 mock）；`access_url` 仅是返回值，本轮不拿它冒充访问成功——下一步真发 curl。

### STEP 4 · 签证书 —— **环境替代（自签，非 ACME；如实标注）**

```text
# 本机无域名、无 ACME 账号、无 80/443 公网可达 → 真 ACME 签发做不到，不伪造成功
$ sha256sum ssl-0.7.1.tar.gz → 8c8c3acf4888586961daaddb34f86961ab4b9d5a071ae0dc0497cad2439428ec  (= 索引)
$ curl ... -d '{"id":"ssl","version":"0.7.1","package_path":"<ssl-0.7.1.tar.gz>","force":true}' .../store/install
HTTP=200  {"id":"ssl-0.7.1","state":"succeeded","message":"安装完成","reload":"reloaded"}
$ curl ... -d '{}' .../plugins/ssl/enable  → HTTP=200 {"enabled":true,...}
$ curl ... -d '{"domain":"golden.local","days":30,"key_type":"rsa2048","extra_sans":["127.0.0.1"]}' \
    .../invoke/ssl/ssl.selfsign
HTTP=200
{"domain":"golden.local","domains":["127.0.0.1","golden.local"],"file":"golden.local.crt",
 "days_left":30,"issuer":"golden.local","subject":"golden.local","key_type":"rsa","key_bits":2048,
 "fingerprint_sha256":"be16d3204152c715ad69131cf80a8f66084cceeb58466a7d446dfc293a047094",
 "self_signed":true,"source":"self-signed","expired":false}
$ find <root>/state/ssl -type f
golden.local.crt  golden.local.key
```

判定：**环境替代**。真实签出一张自签证书（`self_signed:true` / `source:self-signed` / 落盘 crt+key），但**不是 ACME 签发、未绑定到该 HTTP nginx 容器**（site.bindSSL 属 site 插件域，纯静态容器不走那套）。生产环境需真实域名 + ACME 账号才能完成此步的"真签发"语义——本步不冒充。

### STEP 5 · 真实 curl 访问 —— **通过（核心硬指标，首次取证）** ⭐

```text
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18090/
200
```

完整证据（body + 响应头）：

```text
$ curl -s http://127.0.0.1:18090/ | head -c 400
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>kore app-deploy</title></head>
<body><h1>kore app-deploy</h1>
<p>nginx-static / kore-app-golden</p>
<p>把站点文件放进本目录即可替换此页。</p>
</body></html>

$ curl -sI http://127.0.0.1:18090/ | head -8
HTTP/1.1 200 OK
Server: nginx/1.31.9
Date: Tue, 24 Nov 2026 10:14:41 GMT
Content-Type: text/html
Content-Length: 244
Last-Modified: Tue, 24 Nov 2026 10:14:40 GMT
Connection: keep-alive
ETag: "6b056390-f4"
```

判定：**通过**。这是对 `access_url` 真发的 HTTP GET，返回 **200 + 真实 HTML body + nginx 响应头**——不是 access_url 字符串、不是接口 200、不是 DOM 断言。硬指标坐实。

## 4. 与 r21-strategy 基线的差异

| 项 | r21-strategy 基线（HANDOFF §0.0.10，会话产出） | 本轮实际 | 差异 |
| --- | --- | --- | --- |
| 真实 curl 200 | 「从未取证」：e2e-deploy 只返回 access_url，没有真发 curl 记 200 + body（来源 `e2e-deploy-write.md` §2 第 3a 行 + §6「未证明」） | 真发 curl → **200 + body + Server 头**（§3 STEP5） | ✅ 缺口补上 |
| 部署 | e2e-deploy §3a 真起容器 `f3a94f…`（deploy→list→remove 主链路） | 独立隔离实例同样真起容器 `3f57132c…`，绑 18090 | 一致，本轮复用其链路 |
| site@0.4.4 缺 PHP 三方法 | 会话产出（r20-e2e-content），`strings` 命中 0，`getPHP`→404 | 本轮未调 PHP 方法；走纯静态 nginx-static 绕开 | 一致，本轮验证绕行有效 |
| 装运行时 | 基线未单列 | 纯静态路径判定跳过（容器自带 web server） | 本轮新增判定与标注 |
| 签证书 | 基线未单列 | 无域名 → 自签替代，非 ACME，未绑定容器 | 本轮如实标注环境边界 |
| 主实例写边界 | 8787 严格只读 | healthz 200 / PID 2128919 未变 / mtime 未变 / 端口独立 | 一致 |

## 5. 清理彻底性（G-07 / 完成纪律）

```text
$ curl API app-deploy.remove {"name":"kore-app-golden","confirm":true}
HTTP=200  {"removed":true,"name":"kore-app-golden","containers":["kore-app-golden"]}
$ docker ps -a --filter name=kore-app-golden -q | wc -l        → 0（容器零残留）
$ docker volume ls --filter name=kore-app-golden -q | wc -l    → 0（卷零残留）
$ curl 18885/-/healthz → 000（隔离实例已停）
$ curl 8787/-/healthz  → 200（主实例健康）
$ pgrep -af 'kore-r21-golden' | grep -v grep | wc -l           → 0（隔离 kored 零残留）
$ ss -ltn | grep -E ':18885 |:18090 '                          → 0 命中（端口释放）
$ ls /tmp/kore-r21-golden                                      → exists=no（整目录删除）
$ git status --short
?? .agents/verify/e2e-content-write.md    ← r20-e2e-content 轨道，非本轮
?? .agents/verify/e2e-deploy-write.md      ← r20-e2e-deploy 轨道，非本轮
?? .agents/verify/e2e-system-write.md      ← r20-e2e-system 轨道，非本轮
（本轮无临时脚本/日志/口令/cookie 落工作区；以上 3 个是他人未跟踪产物，未触碰）
$ make secret-check → 0 FAIL / 17 处匹配（占位写法均合规）
```

**残留：容器 0 / 卷 0 / 隔离实例 0 / 隔离目录 0 / 临时脚本与口令 0 / 主实例改动 0。**

## 6. 合规声明

- **G-29**：本轮**未改动主实例任何运行态配置**。8787 healthz 200、PID 2128919 未变、二进制 mtime `2026-11-24 17:41:45` 未变、主配置 `index_dir` 字面正确；新证据全部来自 `/tmp/kore-r21-golden` 隔离实例（18885 + 18090），与并行轨道 18879–18884 / 18886 不冲突。无 workaround，无过期条件问题。
- **G-30**：报告与 stdout 全程 `***`；明文口令仅存在于隔离实例内存变量与随目录删除的 0600 配置；`make secret-check` 0 FAIL。
- **G-07**：全部结论附命令 + 退出码 + HTTP + JSON + 真实 curl 输出。
- **写域**：仅新增本报告 `.agents/verify/e2e-golden.md`；未改源码 / 配置 / 主实例；未碰他人未跟踪报告。
- **横向交流**：与 r21-handoff（确认 r21-strategy 会话产出口径、端口不冲突）、r20-e2e-content（复用 site@0.4.4 缺 PHP 三方法发现、确认纯静态绕行有效）已互通过；共性问题 peer 直接裁决。

## 7. 已证明 / 边界（诚实列出）

- **已证明**：隔离实例真构建真登录；site/app-deploy/ssl 三插件本地包真装（sha 与索引一致）+ enable；nginx-static 真起容器绑 18090；**真实 curl 200 + HTML body + Server: nginx/1.31.9**；ssl.selfsign 真签自签证书落盘；清理零残留、8787 零改动。
- **未证明 / 环境边界（不掩饰）**：① STEP4 是**自签**非真实 ACME 签发（无域名 / 无 ACME 账号 / 无公网 80/443），未绑定该 HTTP 容器；② 装运行时按纯静态路径判定跳过，未装 runtime-php/node；③ site.create 建站路径本轮未走（peer 已单独真跑纯静态建站），本轮选 app-deploy nginx-static 作为最短 curl 200 路径；④ `wordpress` / `postgres` 多容器模板未部署（避免扩大清理面）；⑤ HEAD 因并发 agent 在会话内从 `bc9b237f` 推进到 `6e0529a0`，本轮 archive 用启动时真实 HEAD，非全程固定单一 commit。
