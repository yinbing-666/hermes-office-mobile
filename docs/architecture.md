# 架构与数据流

## 生产链路

```text
用户浏览器
  → https://office.example.com
  → Cloudflare Tunnel
  → Nginx
      ├─ / 与静态资源 → ~/frontend/dist
      └─ /api/* → http://127.0.0.1:8787
                    → hermes-office-mobile-bff.service（systemd user service）
                    → FastAPI backend/main.py
```

BFF 绑定 `127.0.0.1:8787`，不直接监听公网地址。Cloudflare Tunnel 和 Nginx 是既有生产链路；应用文档或日常代码修复不得顺带修改其配置。

## 组件职责

### Frontend

- React + TypeScript + 原生 CSS 的移动端 PWA。
- 首次加载先读取 `GET /api/session`；本地认证启用且会话无效时只显示登录页，不提前读取业务数据。
- 从同源 `/api/*` 读取真实数据。
- `localStorage` 只保存前端草稿、空间和会话级交互状态，不能作为 Hermes 已执行的证据。
- 离线缓存只覆盖 app shell；API 失败必须明确显示离线、未确认或无数据。

### FastAPI BFF

- 聚合 Hermes profile、Gateway、Cron、Skills、档案、Kanban、sent、outbox、选题和工作流数据。
- 把消息路由到本机 Hermes API Server；无法确认投递时保留真实失败／兜底状态。
- 读写项目内 `backend/runtime/` 的 outbox、sent 和工作流文件，并提供 Kanban、工作流与专家管线相关 POST 接口。
- 本地认证模式验证服务端会话，并执行角色授权、严格 Origin、CSRF、幂等、用户级限流和脱敏审计。
- 密码使用 scrypt 派生记录保存；浏览器只持有 `Secure`、`HttpOnly`、`SameSite=Strict` 的主机 Cookie，服务端只保存随机 token 的 SHA-256 摘要。
- 读取各 profile 配置中的 API Server key，仅用于本机 Bearer 鉴权；凭证不得进入响应、运行时记录、日志或文档。

### Hermes

Hermes core、Gateway、profile 配置和 Kanban 数据源均属于应用外部依赖。Hermes Office Mobile 可以读取或通过既有接口操作授权范围内的数据，但不得把 BFF 入队、前端模拟或静态缓存描述为 Hermes 已完成。

## 数据流与真实性

1. 浏览器通过同源 GET 请求读取 BFF 聚合数据。
2. 消息类 POST 由 BFF 尝试投递到对应 profile 的本机 API Server。
3. 已确认送达的消息进入 sent 历史；投递失败时可进入 outbox；结果未知时必须显示“未确认”。
4. 工作流编辑结果可持久化，但 `mode=simulated` 的执行不调用 Hermes，也不能展示为真实完成。
5. 专家团只有真实投递与回执预览，不由前端拼接或伪造专家结论。

## 信任边界

- `https://office.example.com/api/*` 是公网入口。
- CORS 只影响浏览器跨域请求，不提供身份认证、接口授权或限流。
- 安全源代码已存在，但密码配置、运行模式、服务重启和公网验收完成前仍按未启用处理。
- 本地认证模式必须同时验证服务端会话与 BFF 角色权限，不能只相信前端按钮状态或可伪造的转发头。
- Tailscale SSH 属于独立恢复平面：可在网页登录失效时交互重置密码、撤销会话和恢复服务，但不能绕过 HTTP 鉴权。
- 写操作、生产发布、配置变更和历史队列恢复必须先说明目标、影响、风险并取得管理员确认。

## 不变量

- 不修改或泄露 `.env`、key、token 和 profile 凭证。
- 不通过文档或测试触发 POST 烟测。
- 移动端 390px 宽度不得出现页面级横向滚动。
- 模拟态、已入队、已送达和已完成必须使用不同且真实的状态文案。
