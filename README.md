# Hermes Office Mobile

移动端 Hermes 可视化办公室，用来管理三个 AI 员工。前端采用 Marvis Office 风格的轻量办公空间隐喻：白色与浅米灰底、统一线性 SVG 图标、员工工位卡和克制的信息层级。

## MVP 闭环

- 办公室首页：展示在线、离线、待补投概览；加入无图片依赖的 CSS 3D 等距虚拟办公室沙盘，通过 perspective、三维旋转、地台与家具厚度、分层阴影呈现茶水厨房、跑步机、四组桌面与显示器、三位员工坐席和绿植。标题下方提供带区域色块的“茶水 / 健身 / 工位”独立图例，并以轻微地面色块对应沙盘分区；主控位小黑、内容位小橙、商业位小金分别使用深灰、橙色、金色的克制坐席标签，点击标签可直接进入对应员工详情。移动端隐藏重复区域浮标、保留员工坐席标识，场景高度控制在约 230–270px。
- 资源与任务概览：首页从现有 `tasks` 真实派生进行中、已完成、总计和最近 3 条任务摘要，继续使用员工名、来源和错误原因中文转换；Token 区当前仅展示“计量源待接入 / 本地模型节省待统计”，不生成虚假消耗数据。
- 员工详情：补全员工档案，展示在线/离线与端口、能力标签、按员工匹配的最近 5 条任务，以及产品化的“人格档案 / 执行手册”状态和最近更新时间；无任务或档案时明确显示待记录。
- 派活入口：优先把任务发送到对应 Hermes API Server；不可用时写入 `backend/runtime/outbox.jsonl` 兜底。
- 专家团执行 MVP：任务页统计区下方默认召集小黑、小橙、小金三位专家，把同一用户问题分别附加主控汇总、内容传播、商业风险角色上下文后并发调用现有 `POST /api/messages`。前端只展示“已发送到 Hermes / 已入队兜底 / 失败”三类投递结果，不读取、拼接或伪造专家回答；真实回答由 Hermes 通道或兜底队列继续承接，投递完成后刷新 outbox 与统一任务历史。
- 工作空间 MVP：新增“空间”Tab，使用 `localStorage` 保存工作空间列表并内置一个示例空间；可填写空间名称、项目目标并选择小黑/小橙/小金作为成员。旧版空间数据与旧日志继续兼容。空间任务按完整空间名称匹配，并固定按 sent 已送达、outbox 待补投、普通任务排序；成员最近任务继续保留为独立辅助区。
- 空间派活：可从当前空间成员中选择一位员工并输入具体任务，复用现有 `sendMessage`；消息包含空间名称、项目目标、目标成员角色视角和任务内容，发送后刷新 outbox 与统一任务历史。
- 空间结果与专家团回执：`GET /api/workspaces/activity` 从 `sent.jsonl`、`outbox.jsonl` 和统一任务中按完整空间名称返回脱敏真实记录。空间结果区展示真实消息、投递状态和 `response_preview`；专家团同批投递写入本地 `batchId`，回执区按成员展示真实回执预览。页面明确使用“回执预览”，不生成专家结论或伪造总结。
- 通道健康：首页展示 `default:8642`、`media-ops:8650`、`investor:8660`、`BFF:8787` 的在线状态、端口和 `timeout=45s`；profile 离线时提示“需要启动 profile gateway”。
- 进化档案：保留成长概览、能力矩阵和员工档案卡，并展示最近 7 天能力增长条形趋势、真实 Git / 档案 / Skill 里程碑，以及消息处理、知识管理、开发执行、自动化四类技能树；每类默认展示前 6 个 Skill，可在当前页面内展开更多或收起，缺失项明确显示暂无或待记录。
- 任务动态：通过 `GET /api/tasks` 聚合 Cron、outbox、sent 与 Gateway activity，统一展示进行中、已完成、待补投、失败/暂停和事件状态；任务卡支持点击打开移动端详情面板，展示标题、状态、来源、员工、时间、现有任务详情、业务化失败原因、技术信息和任务 ID。待补投、失败、暂停或 outbox 来源任务可从详情面板复用兜底队列“逐条重试”，页面不推断或伪造任务结果。成员标识转换为小黑/小橙/小金，来源产品化为定时任务/兜底队列/已送达/网关事件，原始标识与原因仅保留在技术信息中。
- 工作流工作室 MVP：新增“工作流”Tab，接入最小拖拽节点画布，支持节点添加、连线、属性编辑、JSON 导入导出和本地草稿缓存。当前运行模式明确标记为“模拟模式”，不会真正调用 Hermes API Server 或 outbox；真实执行引擎将在下一版接入。
- 工作流服务端持久化：`GET /api/workflows` 返回按 `id` 去重后的工作流列表；`POST /api/workflows` 使用 upsert 语义写入 `backend/runtime/workflows.json`，并兼容迁移旧版 `workflows.jsonl`。`POST /api/workflows/execute` 当前只返回 `mode: "simulated"`，避免把模拟运行误写成真实执行。
- PWA 安装：提供 192 / 512 / maskable 图标、办公室与任务快捷入口，以及 Android 安装提示和 iOS“添加到主屏幕”说明。
- 离线浏览：Service Worker 缓存 app shell、manifest、图标和员工头像；API 始终 network-only，后端不可用时前端明确展示离线缓存或模拟数据并允许继续浏览。

## 启动

开发态启动顺序：先按现有 Hermes 运维方式启动三个 profile gateway，并确认 `8642`、`8650`、`8660` 监听；再启动 BFF `8787`；最后启动 Vite。项目不会修改 Hermes 配置、密钥或 gateway，也不提供生产守护。

后端：

```bash
cd /home/agentuser/projects/hermes-office-mobile/backend
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787
```

前端：

```bash
cd /home/agentuser/projects/hermes-office-mobile/frontend
npm run dev -- --host 127.0.0.1 --port 5173
```

浏览器访问：

```text
http://127.0.0.1:5173/
```

手机通过 Tailscale 访问（需处于同一 Tailnet，前端监听对应端口）：

```text
http://100.99.196.3:5176/
```

打开后可使用首页的“手机访问”提示卡安装到主屏幕。Android 支持浏览器安装提示；iPhone/iPad 请在 Safari 中点“分享”并选择“添加到主屏幕”。

## 验证

```bash
cd /home/agentuser/projects/hermes-office-mobile
backend/.venv/bin/python -m py_compile backend/main.py
cd frontend && npm run build
```

API 烟测：

```bash
curl -sS http://127.0.0.1:8787/api/health
curl -sS http://127.0.0.1:8787/api/agents
curl -sS http://127.0.0.1:8787/api/tasks
curl -sS --get http://127.0.0.1:8787/api/workspaces/activity \
  --data-urlencode 'workspace_name=Hermes 移动工作空间'
curl -sS http://127.0.0.1:8787/api/outbox
curl -sS -X POST http://127.0.0.1:8787/api/outbox/retry \
  -H 'Content-Type: application/json' \
  -d '{"limit":1}'
curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"default","message":"测试任务"}'
```

| Endpoint | 用途 |
|---|---|
| `GET /api/evolution` | 返回 Skill 与档案状态，并从真实修改时间和项目 Git 记录派生 `trend`、`milestones`、`skill_tree` |
| `GET /api/tasks` | 聚合 Cron、`outbox.jsonl`、`sent.jsonl` 和 Gateway activity，状态统一为 `running/completed/queued/failed/paused/event` |
| `GET /api/workspaces/activity` | 按完整空间名称读取脱敏的 sent、outbox 与统一任务记录，并保留真实 `response_preview` |
| `GET /api/health` | 返回四条本地通道的在线状态、端口、45 秒超时配置和离线恢复提示 |
| `POST /api/messages` | 发送任务，优先 API Server；成功写入 sent 历史，失败写入 outbox。BFF 调用 Hermes API Server 的超时为 45 秒，避免慢响应被误判为失败 |
| `GET /api/outbox` | 查看兜底队列最近 50 条 |
| `POST /api/outbox/retry` | 小步重试 outbox，默认/建议一次 1 条，避免手机端长时间等待 |

任务页的“自动补投”默认关闭。用户手动开启后，当前浏览器任务页每 60 秒调用一次现有 `POST /api/outbox/retry`，每次固定只尝试 1 条；关闭开关、离开任务页或刷新页面都会停止，不会创建后台常驻发送任务，也不会跨浏览器会话保存。队列清空后会自动停用并显示完成状态，手动“逐条重试”始终保留。

统一任务历史中的任务卡是可访问按钮，点击后会在列表上方展开任务详情卡。详情仅展示 `TaskItem` 已有字段；当任务属于待补投、失败、暂停状态或来自 outbox 时，详情卡显示兜底队列提示，并沿用当前队列数量与重试中状态控制“逐条重试”按钮。

任务页的“专家团”默认选中并召集三位固定专家，不提供复杂编排配置。一次提交会向 `default`、`media-ops`、`investor` 分别投递带角色视角的问题；页面仅确认投递是否进入 Hermes、进入 outbox 或失败，不把接口响应摘要当作专家结论展示。

`POST /api/messages` 会按 profile 路由到本机 Hermes API Server：

| profile | 端口 | config |
|---|---:|---|
| `default` | 8642 | `/home/agentuser/.hermes/config.yaml` |
| `media-ops` | 8650 | `/home/agentuser/.hermes/profiles/media-ops/config.yaml` |
| `investor` | 8660 | `/home/agentuser/.hermes/profiles/investor/config.yaml` |

后端只读取对应 config 的 `platforms.api_server.extra.key` 用作本机 Bearer 鉴权，不在响应、outbox、sent 或日志中返回该 key。端口离线、key 不可用或请求失败时，接口仍返回成功入队状态，并记录不含敏感信息的 `fallback_reason`。`sent.jsonl` 尚不存在时，统一任务接口按空历史处理，不返回错误。

## 当前边界

- Hermes API Server 为首选发送通道，项目内 outbox 只作为失败兜底。
- 专家团当前只聚合真实投递回执预览，不读取完整会话、不生成最终综合结论。
- 自动补投仅在用户主动开启后的当前浏览器任务页会话内运行，默认关闭，不后台常驻。
- 不修改 Hermes core、gateway、config.yaml、.env 或密钥。
- 不公网暴露，默认本机访问。
- Tailscale 地址仅供同一 Tailnet 内的设备访问，不替代公网部署与鉴权。
- 当前没有 Token 计量数据源，首页不会估算或伪造今日消耗与节省值；接入真实计量前保持待接入状态。
