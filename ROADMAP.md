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
- 兜底队列增加默认关闭的「自动补投」安全开关：仅当前浏览器任务页会话生效，每 60 秒固定重试 1 条；关闭、离开任务页或刷新即停止，队列清空后自动停用并显示完成状态。
- 完成 Marvis Office 风格 UI 第一刀：办公室状态概览、员工工位卡、统一线性 SVG 图标、浅色克制视觉和移动底部导航。
- 完成 Marvis Office 风格首页视觉升级：新增无图片依赖的移动端轻量 CSS 等距办公室，包含茶水区、跑步机、多组工位、显示器和三位员工坐席。
- 完成首页资源与任务概览：从统一 `tasks` 真实派生进行中、已完成、总计和最近 3 条任务摘要；Token 消耗与节省在真实计量源接入前明确保持待统计状态。
- 完成 Marvis Office 风格 UI 第二刀：进化档案升级为产品化成长档案，包含成长概览、能力矩阵、最近进化时间线和三位员工的人格文件状态卡。
- 补齐进化档案文档能力：`/api/evolution` 从 Skill 修改时间、profile 文件状态和项目 Git 提交派生最近 7 天增长趋势、真实里程碑与四类技能树，前端增加条形趋势、时间线和技能分组展示。
- 完成进化页移动端技能树打磨：每个分类默认展示前 6 个 Skill，超出部分通过 Marvis 风格小型按钮在当前页面内展开或收起，并限制长名称避免撑破卡片。
- 任务动态升级为移动任务清单：增加进行中、已完成、待补投统计，保留 outbox「重试 1 条」，Cron 改为任务卡片，Gateway 日志降级为折叠最近事件。
- 补齐统一任务历史：新增 `GET /api/tasks` 聚合 Cron、outbox、sent 与 Gateway activity，统一六类状态；任务页改用统一列表、统一统计和全部/进行中/已完成/待补投/中断失败/事件筛选。
- 成功派活和 outbox 重试成功均写入 `backend/runtime/sent.jsonl`；sent 文件缺失时按空历史返回。
- 主 UI 移除 emoji 与非统一图标，保留四个 Tab、派活和 outbox 重试数据链路。
- 使用 Dragon Image2 生成并接入小黑、小橙、小金三位员工头像，替换临时 SVG 占位图。
- 补全 Agent 员工档案：增加角色能力标签、在线/离线与端口状态、最近任务状态摘要、按员工匹配的最近 5 条任务，并将 SOUL.md / AGENT.md 产品化为“人格档案 / 执行手册”。
- 完成任务页与员工页技术术语降级：成员标识展示为小黑/小橙/小金，任务来源改为中文产品标签，fallback/error code 转换为中文业务文案，原始标识与原因仅保留在 small/meta 技术信息中。
- 补完整移动端 PWA 安装体验：新增 Marvis 浅米灰/蓝调主题、192 / 512 / maskable 图标、manifest 快捷入口、Apple 移动端 meta 与首页轻量安装说明。
- Service Worker 升级到 v2：预缓存 app shell、manifest、图标和三位员工头像，导航离线回退到应用壳；所有 `/api/` 请求保持 network-only。
- 增加 Tailscale 手机访问说明 `http://100.99.196.3:5176/`，并优化后端离线 banner 与无缓存空状态，保留继续浏览能力。
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
- `GET /api/tasks`：200，返回统一排序的任务历史与状态统计。
- `POST /api/outbox/retry`：200，可按 `limit` 小步重试，失败项继续保留。
- 浏览器验证：`/api/agents`、`/api/activity`、`/api/evolution`、`/api/cron`、`/api/messages` 均 200，network failures 为 0。

## 下一步

1. 从首页工位卡快速进入对应员工详情。
2. 接入可信 Token 计量源与本地模型节省统计。
3. 增加 Agent 最近会话摘要。
4. 评估是否把龙虾浏览器资源作为远程 UI 验收节点。

## 暂不做

- 不做公网部署。
- 不做完整聊天历史。
- 不做复杂工作流画布。
- 不接数据库。
- 不增加后台常驻或默认开启的 outbox 自动发送服务。
