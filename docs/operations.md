# 生产运维

## 范围与确认门

本文记录既有生产链路的检查和恢复方式，不授权修改 Cloudflare、Nginx、systemd、`.env`、密钥或运行时数据。发布、服务重启、配置修改、outbox 清理／恢复和任何 POST 验证都必须先取得主人确认。

## 登录凭据（本地验证）

- 办公室密码（浏览器登录）：`20171419hermesoffice`
- 用途：office.icewill.tech 本地密码验证（`auth_mode=local`），仅用于前端登录；忘记时通过 Tailscale SSH 在服务器重设（见 docs/specs/2026-08-01-local-auth-security-design.md）。
- 注意：本文件在 git 仓库内，已属于私有仓库；如需公开仓库请改用密钥文件。

## 生产拓扑

```text
Cloudflare Tunnel
  → Nginx
    → frontend/dist
    → /api/* → 127.0.0.1:8787
      → hermes-office-mobile-bff.service
```

项目目录：`/home/agentuser/projects/hermes-office-mobile`

## 构建前检查

```bash
cd /home/agentuser/projects/hermes-office-mobile
git status --short
git diff --check
backend/.venv/bin/python -m py_compile backend/main.py
cd frontend
make gate
```

`make gate` 只执行前端静态检查和构建，不得包含 POST 请求。工作区有未提交改动时，先确认本次文件范围，不覆盖或回滚他人改动。

## 前端构建与缓存确认

Nginx 直接读取项目内 `frontend/dist`，因此在服务器执行生产构建就是更新线上静态文件，属于公开发布动作，必须先确认。

确认后应先备份当前构建目录，再执行：

```bash
cd /home/agentuser/projects/hermes-office-mobile/frontend
npm run build
```

发布后只读确认：

```bash
curl -sS https://office.icewill.tech/ | grep -oE 'assets/index-[^" ]+\.js'
curl -sSI https://office.icewill.tech/manifest.json
curl -sSI https://office.icewill.tech/favicon.svg
```

同时核对公网 HTML 引用的资源哈希与 `frontend/dist/index.html` 一致。浏览器执行硬刷新，检查 Service Worker 缓存、控制台错误和失败请求；不能只凭 `npm run build` 成功判断发布完成。

## 鉴权上线门禁

当前仓库已经包含本地密码、服务端会话、RBAC、CSRF、幂等和限流代码，但默认 `HERMES_AUTH_MODE=disabled`。仅有源代码或测试通过不表示线上已受保护。

上线必须逐步确认：

1. 当前只同步和验证源代码，保持运行中服务不变。
2. 单独确认后以 `HERMES_AUTH_MODE=disabled` 重启 BFF，使新的 session 接口生效但不拦截现有页面；只读验证健康接口和 `GET /api/session`。
3. 单独确认后执行前端生产构建和发布；验证禁用模式下原有页面可用，登录页代码不会误拦截。
4. 单独确认后通过 Tailscale SSH 交互运行 `.venv/bin/python manage_local_auth.py set-password --email <管理员邮箱>`。密码由终端隐藏输入，不得放入参数、聊天、日志或仓库；该操作会撤销全部已有会话。
5. 单独确认后把运行模式设为 `HERMES_AUTH_MODE=local` 并重启 BFF。缺少配置、权限不是 `0600` 或配置无效时必须启动失败，不得退回公开模式。
6. 使用浏览器验证未登录仅出现登录页、错误密码被统一拒绝、正确密码可进入、退出后会话失效，以及健康接口和只读页面正常。不要通过关闭中间件完成验收。

本地认证启用后，直接访问 `127.0.0.1:8787/api/*` 也需要有效会话，不存在 Tailscale IP 或本机回环免登录。恢复时通过 Tailscale SSH 运行 `manage_local_auth.py status` 查看脱敏状态；密码重置、运行配置修改和服务重启仍需分别确认。

## BFF 服务检查

以下命令只读：

```bash
systemctl --user is-active hermes-office-mobile-bff.service
systemctl --user status hermes-office-mobile-bff.service --no-pager
ss -ltn | grep ':8787'
curl -sS http://127.0.0.1:8787/api/health
curl -sS https://office.icewill.tech/api/health
```

服务重启会中断正在处理的请求，必须在代码检查通过并取得主人确认后执行：

```bash
systemctl --user restart hermes-office-mobile-bff.service
```

重启后必须再次核对 `active`、本机健康接口和公网健康接口。

## 默认公网验证

只调用 GET：

```bash
curl -sS https://office.icewill.tech/api/health
curl -sS https://office.icewill.tech/api/agents
curl -sS https://office.icewill.tech/api/tasks
curl -sS https://office.icewill.tech/api/outbox
```

不得在常规 smoke test 中调用 `/api/messages`、`/api/outbox/retry`、Kanban、工作流或专家 POST 接口。

## 回滚

### 前端

发布前保存带时间戳的 `frontend/dist` 备份并记录当前 HTML 资源哈希。若发布后验收失败，停止继续发布，保留失败页面、控制台、网络请求和构建日志；取得主人确认后，再把已验证的备份内容恢复到 `frontend/dist`，并重复公网 HTML、资源哈希和浏览器缓存验证。

### BFF

保留变更前文件和差异证据。若重启后服务或只读接口失败，不执行 `git reset`、`checkout --` 或自动覆盖工作区；先报告失败证据和准确改动范围，取得主人确认后再恢复明确的备份文件并重启服务。

## Outbox 归档与恢复

活动文件为 `backend/runtime/outbox.jsonl`。归档、清空和恢复都会影响后续真实投递，必须单独确认。

安全流程：

1. 停止自动补投，读取 `GET /api/outbox` 确认数量、旧消息数量和时间范围。
2. 在相同目录创建带 UTC 时间戳的 `outbox.archive-<timestamp>.jsonl` 逐字节副本。
3. 比较原文件与归档的字节数、记录数和 SHA-256；不得打印消息正文或凭证。
4. 取得主人对精确记录范围的确认后，才可清理活动队列。
5. 清理后通过 `GET /api/outbox` 验证数量，不调用 retry。

恢复流程：

1. 说明要恢复的归档路径、记录数、时间范围和可能重新发送的风险。
2. 取得主人确认，并再次备份当前活动 outbox。
3. 验证归档哈希后恢复；保持自动补投关闭。
4. 先用 `GET /api/outbox` 核对，旧消息默认继续受 48 小时保护。
5. 除非再次逐条确认，不得设置 `allow_stale=true`。

## 应保留的运维证据

- 执行时间、目标主机和项目路径。
- 变更前后的 `git status --short` 与目标文件 diff。
- 构建、`git diff --check` 和服务状态结果。
- 本机／公网 GET 状态码与资源哈希。
- 失败时的原始命令、错误文本、浏览器控制台和网络请求；敏感值必须脱敏。
