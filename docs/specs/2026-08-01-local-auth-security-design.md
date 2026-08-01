# 本地登录与 Tailscale 恢复安全设计

## 状态

- 方案已由主人确认。
- 当前阶段只实施代码、测试和文档，不生成真实密码，不修改 systemd，不重启服务，不发布前端。
- 生产启用仍需分别确认前端发布、交互式密码设置、systemd 运行模式和服务重启。

## 场景

`office.icewill.tech` 是个人 Hermes 办公室。Cloudflare Access 免费套餐开通流程无法在没有银行卡的条件下完成，因此认证边界改为 FastAPI 本地单管理员会话。Tailscale 仅承担 SSH 恢复通道，不作为 HTTP 绕过入口。

## 目标

- 未登录用户不能读取或调用任何 Hermes 业务 API。
- 单管理员通过本地密码登录，浏览器只持有不可读的会话 Cookie。
- 密码、会话原文、消息正文和其他凭证不进入仓库、前端、日志或错误响应。
- 继续复用角色检查、严格 Origin、CSRF、幂等、按会话限流和脱敏审计。
- 忘记密码时，通过 Tailscale SSH 交互式重设，并撤销全部旧会话。

## 非目标

- 不提供注册、找回密码邮件、短信或第三方 OAuth。
- 不增加 Tailscale IP 白名单、固定 Header、查询参数或隐藏 URL 作为登录绕过。
- 不把密码或固定 token 写入前端、localStorage、代码仓库或命令行参数。
- 不保护不含业务数据的静态登录页和前端资源；所有业务数据由 API 鉴权保护。
- 不修改 Hermes core、Gateway、Kanban 数据结构或工作流真实执行范围。

## 请求链路

```text
Browser
  -> Cloudflare Tunnel
  -> Nginx static login shell and /api proxy
  -> FastAPI local session / RBAC / CSRF / rate limit / idempotency
  -> Hermes channels and runtime files

Tailscale SSH
  -> interactive manage_local_auth.py set-password
  -> password hash updated and all sessions revoked
```

## 配置与存储

| 配置或文件 | 说明 |
|---|---|
| `HERMES_AUTH_MODE` | `disabled` 或 `local`；默认 `disabled` |
| `HERMES_ALLOWED_ORIGIN` | 默认 `https://office.icewill.tech` |
| `HERMES_LOCAL_AUTH_CONFIG` | 可选，本地认证配置文件路径 |
| `HERMES_SESSION_TTL_SECONDS` | 默认 604800 秒，允许 900 至 2592000 秒 |
| `backend/runtime/local-auth.json` | 管理员邮箱和 scrypt 密码记录，权限 600 |
| `backend/runtime/sessions.json` | 会话 token 的 SHA-256 摘要、邮箱和过期时间，权限 600 |
| `backend/runtime/idempotency.json` | 写操作幂等结果，权限 600 |
| `backend/runtime/security-audit.jsonl` | 脱敏安全审计，权限 600 |

`local` 模式缺少或损坏认证配置时必须启动失败，不能静默退回公开模式。会话文件损坏同样启动失败。

## 密码与会话

- 密码至少 12 个字符，最长 256 个字符。
- 使用 Python 标准库 scrypt，参数固定为 N=16384、r=8、p=1、32 字节输出和随机 16 字节盐。
- 密码比较使用恒定时间比较。
- 登录成功后生成至少 32 字节熵的随机会话 token。
- 服务端只保存 token 的 SHA-256 摘要，浏览器 Cookie 保存原始 token。
- Cookie 为 host-only，并设置 `HttpOnly`、`Secure`、`SameSite=Strict` 和 `Path=/`。
- 会话固定 7 天过期，不在每次请求时滚动，减少运行文件写入。
- 退出登录、重设密码或恢复操作会撤销对应会话或全部会话。

## 登录防护

- `POST /api/auth/login` 不要求已有会话，但要求精确 Origin 和 `X-Hermes-CSRF: 1`。
- 每个来源地址 15 分钟最多 5 次失败，全局 15 分钟最多 30 次失败。
- 优先使用 Cloudflare 注入的有效 `CF-Connecting-IP`，否则回退到连接地址。
- 错误密码统一返回 `invalid_credentials`，不区分账户、哈希或配置状态。
- 超限返回 429、`login_rate_limited` 和 `Retry-After`。
- 审计仅保存来源地址哈希，不保存来源地址、密码或请求体。

## API 边界

- `GET /api/session` 可匿名调用，只返回是否启用和是否已登录，不泄露管理员邮箱。
- `POST /api/auth/login` 可匿名调用，只处理密码验证。
- 其他 `/api/*` 在 `local` 模式必须持有有效会话。
- 当前本地账户固定为 admin，现有 viewer／operator／admin 路由策略继续保留以便未来扩展。
- 所有状态变更继续要求精确 Origin、CSRF 头和规范 UUID 幂等键。

## 前端行为

- 首屏只请求 `/api/session`。
- 未登录时只渲染密码登录页，不请求 agents、tasks、outbox、topics、workflows 或 channel health。
- 登录成功后再加载业务数据。
- 会话失效时显示登录页，不用离线模拟数据掩盖 401。
- 提供明确退出入口；退出后清理当前内存中的业务数据。
- 忘记密码只说明 Tailscale SSH 恢复，不提供网页绕过按钮。

## Tailscale 恢复

运行命令时密码通过 `getpass` 交互输入，不进入 shell history、进程参数或日志：

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
.venv/bin/python manage_local_auth.py set-password --email '<管理员邮箱>'
```

首次设置需要邮箱，后续重设沿用现有邮箱。每次设置成功都覆盖密码记录并将会话文件写为空对象，从而撤销全部旧会话。

## 分阶段上线

1. 更新设计、代码、测试和文档，不触碰线上进程。
2. 运行后端单元测试、Python 编译、前端 TypeScript 检查和差异检查。
3. 单独确认后发布兼容登录态的前端；后端仍为 disabled，现有访问不受影响。
4. 由主人或经确认的交互终端设置真实密码，验证文件权限和脱敏状态命令。
5. 单独确认后设置 `HERMES_AUTH_MODE=local` 并重启 BFF。
6. 验证匿名 session 状态、匿名业务 API 401、错误密码 401、正确密码登录、Cookie 属性和退出。
7. 验证 Tailscale SSH 重设密码后旧会话立即失效。

## 验收标准

- `disabled` 模式保持当前行为，源文件更新不会自行启用认证。
- `local` 模式缺少配置时启动失败。
- 错误密码、跨站 Origin 和超限登录不能创建 Cookie。
- Cookie 中包含 `HttpOnly`、`Secure` 和 `SameSite=Strict`。
- 会话文件不包含原始 token，认证文件不包含明文密码。
- 匿名访问业务 GET 和 POST 均不能进入业务处理函数。
- 登录后 admin 可以读取业务 API，写接口仍需 CSRF 和幂等键。
- 退出和密码重设后旧会话无法继续使用。
- 未登录前端不发起业务 API 请求。
- 审计与错误响应不包含密码、Cookie、会话 token、消息正文或 API key。
