# Cloudflare Access 与 BFF 安全设计（已停止采用）

## 状态

- 2026-08-01 因 Zero Trust Free 开通流程要求绑定银行卡，决定停止采用本方案。
- 当前替代方案见 `2026-08-01-local-auth-security-design.md`。
- 本文仅保留为历史决策记录，Cloudflare Access 代码不得作为当前上线依据。
- 代码默认保持 `HERMES_AUTH_MODE=disabled`，不会仅因源文件更新而改变线上访问。
- Cloudflare、环境变量、systemd、服务重启和前端发布仍需分别确认。

## 场景

`office.example.com` 是个人 Hermes 办公室，不是匿名公共产品。页面展示 Hermes 状态，写接口可以发送消息、补投 outbox、修改 Kanban 状态或启动专家流程，因此静态页面和 API 都应只向被允许的身份开放。

## 目标

- Cloudflare Access 在边缘保护整个主机名。
- FastAPI 验证 `Cf-Access-Jwt-Assertion`，不盲目信任转发头或 Cookie。
- GET 至少需要 viewer；POST 按 operator、admin 分级。
- 状态变更请求同时受 CSRF、限流和幂等保护。
- 审计日志不记录消息正文、Access JWT、Cookie、API key 或其他凭证。

## 非目标

- 不自建账号密码系统。
- 不把固定 token 写进前端或 localStorage。
- 不修改 Hermes core、Gateway 或 Kanban 数据结构。
- 不保证跨进程、跨外部系统的严格 exactly-once；BFF 幂等仅减少重复提交。
- 本阶段不把模拟工作流改成真实执行。

## 请求链路

```text
Browser
  -> Cloudflare Access
  -> Cloudflare Tunnel
  -> Nginx
  -> FastAPI Access JWT / RBAC / CSRF / rate limit / idempotency
  -> Hermes channels and runtime files
```

## 配置

只记录配置名，不在仓库记录真实值：

| 配置 | 说明 |
|---|---|
| `HERMES_AUTH_MODE` | `disabled` 或 `enforce` |
| `CF_ACCESS_TEAM_DOMAIN` | Access 团队 HTTPS 域名 |
| `CF_ACCESS_AUD` | 当前 Access 应用的 Audience Tag |
| `HERMES_AUTH_ADMIN_EMAILS` | 逗号分隔的 admin 邮箱 |
| `HERMES_AUTH_OPERATOR_EMAILS` | 可选，逗号分隔的 operator 邮箱 |
| `HERMES_ALLOWED_ORIGIN` | 默认 `https://office.example.com` |

`enforce` 模式缺少团队域名、AUD 或 admin 邮箱时必须启动失败，不能静默退回公开模式。

## 身份和权限

| 角色 | 权限 |
|---|---|
| viewer | 所有 GET |
| operator | viewer、消息发送、工作流保存、当前模拟执行 |
| admin | operator、outbox 补投、Kanban 解阻塞、专家总结和专家流水线 |

未知但已通过 Access 的邮箱默认为 viewer。FastAPI 必须独立校验角色，前端隐藏按钮不构成授权。

## JWT 验证

- 只读取 `Cf-Access-Jwt-Assertion`。
- 算法固定为 RS256。
- 通过团队 `/cdn-cgi/access/certs` 获取并缓存 JWKS。
- 校验签名、`iss`、`aud`、`exp`、`iat` 和 `sub`。
- token 中必须存在非空 email。
- JWKS 暂时不可用返回 503；缺失或非法 token 返回 401。

## 状态变更保护

所有非 GET／HEAD／OPTIONS 请求必须：

1. `Origin` 精确等于 `HERMES_ALLOWED_ORIGIN`。
2. 携带 `X-Hermes-CSRF: 1`。
3. 携带规范 UUID 格式的 `Idempotency-Key`。

幂等键按“Access subject＋方法＋规范化路由＋键值”组合，完成结果保存 24 小时。重复请求返回首次 JSON 结果；正在执行中的重复请求返回 409。5xx 或无法解析为 JSON 的响应不缓存。

## 限流

| 接口 | 限制 |
|---|---|
| 普通 GET | 120 次／分钟／用户 |
| `POST /api/messages` | 10 次／分钟／用户 |
| `POST /api/workflows` | 20 次／分钟／用户 |
| `POST /api/workflows/execute` | 20 次／分钟／用户；变成真实执行前必须降低 |
| `POST /api/outbox/retry` | 1 次／分钟／用户 |
| `POST /api/kanban/unblock/{task_id}` | 3 次／10 分钟／用户 |
| `POST /api/experts/summarize` | 3 次／10 分钟／用户 |
| `POST /api/experts/pipeline` | 1 次／10 分钟／用户 |

当前 BFF 是单进程，应用级固定窗口限流在进程重启后重置。Cloudflare WAF 只作为额外的 IP 级粗限流，不替代应用内按身份限流。

## 审计

状态变更审计写入 `backend/runtime/security-audit.jsonl`，权限为 600，只记录时间、邮箱哈希、角色、方法、规范化路由、request ID、状态码和结果分类。幂等记录写入 `backend/runtime/idempotency.json`，权限为 600。

## 错误契约

| HTTP | 含义 |
|---|---|
| 400 | 幂等键缺失或格式非法 |
| 401 | Access JWT 缺失、过期或验签失败 |
| 403 | 权限不足或 CSRF 校验失败 |
| 409 | 同一幂等操作仍在执行 |
| 429 | 超出用户级限流，并返回 `Retry-After` |
| 503 | Access JWKS 暂时不可用 |

响应携带 `X-Request-ID`，但不返回底层验签异常、token 或配置值。

## 分阶段上线

1. 本地完成模块测试、后端编译和前端类型检查，不重启、不发布。
2. 单独确认后，读取现有 Access 配置并确认允许邮箱、团队域名和 AUD。
3. 单独确认后，为整个 `office.example.com/*` 创建或调整 Access 应用。
4. 验证被允许邮箱可登录、其他身份被拒绝。
5. 单独确认后写入运行配置，启用 `HERMES_AUTH_MODE=enforce` 并重启 BFF。
6. 单独确认后构建前端；因为 `frontend/dist` 是 Nginx 线上目录，该构建等同发布。
7. 只使用 GET 和无副作用拒绝用例验收；任何成功 POST 仍需单独授权。

## 验收标准

- 未登录访问整站会进入 Access 登录流程。
- 非允许邮箱无法进入。
- 允许邮箱登录后，FastAPI 能识别邮箱、角色和能力。
- 缺失、伪造、错误 AUD 或过期 JWT 均不能访问 API。
- viewer 调用写接口返回 403。
- 跨站 Origin、缺失 CSRF 头或非法幂等键不会触发业务函数。
- 重复幂等键不会产生第二次业务执行。
- 超限返回 429 和 `Retry-After`。
- 审计与错误响应不包含 JWT、Cookie、消息正文或 API key。
