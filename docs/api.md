# API 与副作用

## 使用原则

- 默认烟测只调用 GET。
- 所有 POST 均视为可能产生真实副作用；执行前必须取得管理员针对本次目标的确认。
- 安全代码已实现但默认禁用；真实密码、运行配置、服务重启和公网验收完成前，线上不能视为已启用鉴权。
- CORS 不是认证；本地认证模式由密码校验、服务端会话、角色授权、CSRF、幂等和应用级限流共同构成。
- 文档、日志和响应不得包含 API Server key、密码、会话 Cookie 或其他凭证值。

## 只读接口

| 接口 | 用途 | 主要数据源 |
|---|---|---|
| `GET /api/session` | 当前认证状态、角色和能力 | 服务端会话；禁用模式返回认证未启用且兼容现有页面 |
| `GET /api/health` | BFF 与三个 Hermes 通道健康状态 | 本机端口与配置存在性 |
| `GET /api/agents` | 员工档案和在线状态 | Hermes profiles |
| `GET /api/activity` | 脱敏 Gateway 活动 | Hermes 日志／状态 |
| `GET /api/evolution` | Skills、档案、趋势和里程碑 | 文件元数据与 Git |
| `GET /api/cron` | 定时任务摘要 | Hermes Cron |
| `GET /api/kanban/tasks` | Kanban 任务列表 | `~/.hermes/kanban.db` |
| `GET /api/tasks` | 统一任务历史 | Cron、Kanban、sent、outbox、Gateway |
| `GET /api/workspaces/activity` | 指定空间的真实活动 | sent、outbox、统一任务 |
| `GET /api/delegation/{delegation_id}/tasks` | 委派任务状态 | `~/.hermes/cache/delegation/live/<id>/` |
| `GET /api/outbox` | 兜底队列摘要与旧消息统计 | `backend/runtime/outbox.jsonl` |
| `GET /api/workflows` | 已保存工作流 | `backend/runtime/workflows.json` |
| `GET /api/topics` | 最近有效选题 | `/tmp/topics_{date}.md` |

## 认证接口

| 接口 | 用途 | 约束 |
|---|---|---|
| `POST /api/auth/login` | 使用本地管理员密码建立会话 | 严格同源、CSRF 标记、登录限流；禁用模式返回 `409 auth_not_enabled` |
| `POST /api/auth/logout` | 撤销当前服务端会话并清除 Cookie | 需要有效会话、严格同源、CSRF 与幂等键 |

密码正文和原始会话 token 不得写入日志、审计、文档或命令历史。登录成功只证明认证成功，不授权执行其他业务 POST。

只读烟测示例：

```bash
curl -sS http://127.0.0.1:8787/api/health
curl -sS http://127.0.0.1:8787/api/tasks
curl -sS http://127.0.0.1:8787/api/outbox
curl -sS https://office.example.com/api/health
```

## 有副作用接口

| 接口 | 可能影响 | 执行前确认重点 |
|---|---|---|
| `POST /api/messages` | 向 Hermes 投递消息，并写 sent 或 outbox | 目标 profile、消息内容、是否允许真实发送 |
| `POST /api/outbox/retry` | 重发队列消息并重写 outbox | 队列内容、消息年龄、重试数量、外部发送风险 |
| `POST /api/workflows` | 新增或覆盖工作流持久化数据 | 工作流 ID、覆盖范围、备份情况 |
| `POST /api/experts/summarize` | 调用专家总结流程 | batch、成本、外部调用与结果归属 |
| `POST /api/kanban/unblock/{task_id}` | 修改 Kanban 状态并可能续跑任务 | 精确 task_id、阻塞决策、续跑影响 |
| `POST /api/workflows/execute` | 当前返回模拟执行；未来可能触发真实 Hermes 调用 | 必须核对 `mode`，不能把模拟当真实完成 |
| `POST /api/experts/pipeline` | 向多位专家投递并产生运行时记录 | 问题内容、参与 profile、调用与补投风险 |

强制模式下，所有 POST 还必须携带精确 Origin、`X-Hermes-CSRF: 1` 和规范 UUID 格式的 `Idempotency-Key`。viewer 只能调用 GET；operator 只能执行消息和工作流操作；其余写接口要求 admin。安全错误使用 400／401／403／409／429／503，并返回 `X-Request-ID`；429 同时返回 `Retry-After`。

本项目禁止把 POST 加入默认 smoke test。即使请求体使用“测试”字样，也可能产生真实远端消息或状态变化。

## Outbox 保护策略

- 自动补投默认关闭，只能由用户在当前浏览器任务页主动开启。
- 自动补投不应跨刷新或跨浏览器会话保持，也不创建后台常驻发送任务。
- 超过 48 小时的消息默认视为旧消息并跳过，防止历史测试内容被意外发送。
- `allow_stale=false` 是默认安全行为；`allow_stale=true` 会允许旧消息真实重发，只能在逐条核对内容、目标和数量并取得管理员确认后使用。
- 手动清理前先制作带时间戳的逐字节归档并验证记录数与哈希；恢复同样属于覆盖运行时数据的写操作，需要单独确认。

## 投递状态语义

- **已送达**：本机 Hermes API Server 明确返回成功。
- **已入队**：BFF 明确把消息写入 outbox，尚不代表 Hermes 执行。
- **未确认／失败**：网络或服务结果无法确认，不得伪装为已入队或已完成。
- **模拟完成**：仅说明本地模拟流程结束，不代表调用 Hermes 或产出真实业务结果。
