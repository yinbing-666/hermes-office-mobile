# ROADMAP

## 当前阶段

MVP v1：Hermes Office Mobile 已跑通本地最小闭环。

## 已完成

- 初始化项目骨架和约束文档。
- 实现 FastAPI BFF：`/api/health`、`/api/agents`、`/api/activity`、`/api/evolution`、`/api/cron`。
- 实现 Vite React PWA：办公室、Agent 详情、进化档案、任务动态四个 Tab。
- 实现长期可用版派活第一刀：`POST /api/messages` 优先调用对应 Hermes API Server，失败写入 `backend/runtime/outbox.jsonl`。
- 实现三 profile 路由：`default:8642`、`media-ops:8650`、`investor:8660`，Bearer key 只从各自 config 的 `platforms.api_server.extra.key` 读取。
- 前端发送状态区分“已发送到 Hermes”和“已入队兜底”。
- 实现长期可用版第二刀：`GET /api/outbox` 展示兜底队列，`POST /api/outbox/retry` 小步重试投递，成功写入 `backend/runtime/sent.jsonl`，失败保留 outbox。
- 任务动态页增加「兜底队列」模块和「重试 1 条」按钮，避免移动端长时间卡在批量重试。
- 完成 Marvis Office 风格 UI 第一刀：办公室状态概览、员工工位卡、统一线性 SVG 图标、浅色克制视觉和移动底部导航。
- 主 UI 移除 emoji 与非统一图标，保留四个 Tab、派活和 outbox 重试数据链路。
- 完成前端生产构建验证：`npm run build`。
- 完成后端语法和 API 烟测。
- 完成 Chrome Headless/CDP 浏览器真实验证：页面加载、Tab 切换、API 请求、派活按钮、outbox 写入。

## 最近验证

- `backend/.venv/bin/python -m py_compile backend/main.py`：通过。
- `cd frontend && npm run build`：通过。
- `GET /api/health`：200。
- `GET /api/agents`：200，返回 3 个 Agent。
- `POST /api/messages`：API Server 可用时直接发送；端口、key 或请求异常时返回 outbox 兜底结果。
- `GET /api/outbox`：200，返回兜底队列数量和最近消息。
- `POST /api/outbox/retry`：200，可按 `limit` 小步重试，失败项继续保留。
- 浏览器验证：`/api/agents`、`/api/activity`、`/api/evolution`、`/api/cron`、`/api/messages` 均 200，network failures 为 0。

## 下一步

1. 增加 outbox 重试/消费机制，恢复后自动补投。
2. 增加移动端访问方式：Tailscale 内网优先。
3. 继续打磨办公室交互：从工位卡快速进入员工详情，并补充最近任务摘要。
4. 增加 Agent 最近会话和最近任务摘要。
5. 评估是否把龙虾浏览器资源作为远程 UI 验收节点。

## 暂不做

- 不做公网部署。
- 不做完整聊天历史。
- 不做复杂工作流画布。
- 不接数据库。
