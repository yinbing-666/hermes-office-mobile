# Hermes Office Mobile 完善计划

## 目标
把 Hermes Office Mobile 从当前的「可用 MVP」完善为一个稳定的移动端 Agent 工作台，重点补齐项目空间闭环、专家回答回流、运行可靠性和移动端验收体验。

## 背景
当前项目已经完成办公室、空间、员工、进化、任务五个 Tab：

- 办公室首页已经有 3D 沙盘、员工坐席跳转、资源与任务概览。
- 空间页已经支持创建空间、选择成员、空间派活、空间内专家团、空间日志、空间相关真实任务匹配和 mini stats。
- 员工页已经展示员工状态、角色能力、人格档案 / 执行手册和最近任务。
- 进化页已经展示 Skill 增长、里程碑、能力矩阵和员工档案。
- 任务页已经有统一任务历史、任务详情、outbox、逐条重试和默认关闭的自动补投。
- BFF 派活超时已从 12 秒提升到 45 秒，default / media-ops / investor 三条 API Server 通道已恢复。

距离「完善」主要还差四类闭环：

1. 空间只是本地项目容器，还没有真正的项目结果沉淀。
2. 专家团现在只展示投递状态，没有回答聚合和空间内结果回流。
3. 运行态依赖手动拉起 gateway / BFF / 前端，缺少启动守护和健康诊断。
4. UI 已可用，但长列表、移动端层级、空状态和截图验收还需要最后一轮产品化打磨。

## 方案

1. 补齐「空间结果回流」第一版。
   - 在 `backend/main.py` 增加读取 `backend/runtime/sent.jsonl` 的空间过滤能力。
   - 在 `GET /api/tasks` 或新增 `GET /api/workspaces/activity` 中返回命中空间名称的 sent / outbox / task 记录。
   - 在 `frontend/src/App.tsx` 的空间页新增「空间结果」区块，只展示真实 sent/outbox/task 记录，不生成 AI 总结。
   - 保持 `localStorage` 的空间列表和日志，不引入数据库。

2. 做「专家团回答聚合」最小闭环。
   - 先不读取其他 Hermes 会话全文，只使用 `sent.jsonl` 中已有的 `response_preview`。
   - 在空间日志中把同一轮专家团投递用 `batchId` 关联起来。
   - 在空间页新增「专家团回执」卡片，按小黑 / 小橙 / 小金显示：已发送、待补投、失败、response_preview。
   - 不做最终综合结论生成，避免伪造专家回答。

3. 增加「空间内任务创建」与「任务归属」的弱持久化规则。
   - 在 `frontend/src/App.tsx` 中，空间派活发出的消息继续带完整空间名称。
   - 在 `backend/main.py` 写 sent/outbox 时保留完整 `message_preview` 和必要上下文，确保后续可按空间名称匹配。
   - 在空间页把「空间任务摘要」排序改为：sent 已送达优先、outbox 待补投次之、普通任务最后。
   - 保留「成员最近任务辅助区」作为参考，不再混到空间任务摘要里。

4. 增加运行态健康诊断区。
   - 在 `backend/main.py` 的 `/api/health` 或 `/api/agents` 增加每个 profile 的 API Server 状态、端口、最近错误原因、BFF timeout 配置。
   - 在 `frontend/src/App.tsx` 首页或任务页增加「通道健康」卡片。
   - 展示 default:8642、media-ops:8650、investor:8660、BFF:8787 的在线状态。
   - 当某个端口离线时，明确显示「需要启动 profile gateway」，不只显示离线。

5. 补齐进程启动与守护说明。
   - 在 `README.md` 增加启动顺序：三个 Hermes gateway、BFF、Vite dev server。
   - 在 `ROADMAP.md` 记录当前不是生产守护，仅是开发态进程。
   - 可选新增 `scripts/start-dev.sh`，一键检查并启动 BFF / frontend，但不自动改 Hermes 配置。
   - 如果后续需要长期运行，再单独设计 systemd / s6 / supervisor，不在本轮直接做。

6. 做移动端 UI 最后一轮可读性打磨。
   - 在 `frontend/src/styles.css` 检查空间页长列表、日志卡、任务卡在 320px / 390px 宽度下是否撑破。
   - 对空间日志、专家团回执、任务摘要增加更清晰的空状态文案。
   - 对底部 Tab 上方补足滚动底部 padding，避免最后一个卡片被 tabbar 遮挡。
   - 保持现有 Marvis Office 浅色风格，不新增花哨渐变和 emoji。

7. 补齐验证脚本与验收清单。
   - 在 `README.md` 增加固定验证命令：`python -m py_compile`、`npm run build`、`GET /api/agents`、`POST /api/messages`、`POST /api/outbox/retry`。
   - 在 `ROADMAP.md` 的「最近验证」补充三 profile delivered=true 的验证记录格式。
   - 使用 CDP / Headless Chrome 验证：页面加载、空间 Tab、空间派活、专家团投递、空间日志、控制台、network failures。

8. 暂不做数据库和公网发布。
   - 空间数据继续放 `localStorage`。
   - 不接 D1 / SQLite。
   - 不做公网域名和鉴权。
   - 不做真实 Token 统计。
   - 不做自动后台批量补投。

## 涉及文件

预计会修改：

- `backend/main.py`
  - 增加空间相关 sent/outbox 过滤能力。
  - 增加健康诊断字段。
  - 保持派活安全脱敏和 45 秒 timeout。

- `frontend/src/App.tsx`
  - 增加空间结果区块。
  - 增加专家团回执区块。
  - 增加通道健康卡片。
  - 优化空间任务排序和展示边界。

- `frontend/src/styles.css`
  - 增加空间结果、专家团回执、通道健康卡片样式。
  - 修复底部 Tab 遮挡和窄屏长文本问题。

- `README.md`
  - 更新启动方式、验证方式、当前边界。

- `ROADMAP.md`
  - 更新已完成、最近验证、下一步和暂不做事项。

可选新增：

- `scripts/start-dev.sh`
  - 仅用于开发态启动检查，不修改 Hermes 配置。

## 验证方式

每一刀完成后执行以下验证：

1. 后端语法验证。

```bash
cd /home/agentuser/projects/hermes-office-mobile
backend/.venv/bin/python -m py_compile backend/main.py
```

2. 前端构建验证。

```bash
cd /home/agentuser/projects/hermes-office-mobile/frontend
npm run build
```

3. API 健康检查。

```bash
curl -sS http://127.0.0.1:8787/api/health
curl -sS http://127.0.0.1:8787/api/agents
curl -sS http://127.0.0.1:8787/api/tasks
curl -sS http://127.0.0.1:8787/api/outbox
```

4. 三 profile 派活验证。

```bash
curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"default","message":"通道验证：请只回复收到"}'

curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"media-ops","message":"通道验证：请只回复收到"}'

curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"investor","message":"通道验证：请只回复收到"}'
```

验收标准：三次响应均包含：

```text
delivered=true
channel=api_server
```

5. outbox 小步补投验证。

```bash
curl -sS -X POST http://127.0.0.1:8787/api/outbox/retry \
  -H 'Content-Type: application/json' \
  -d '{"limit":1}'
```

验收标准：接口返回 200，且 `attempted`、`delivered`、`remaining` 字段存在。

6. 浏览器真实验证。

- 打开 `http://127.0.0.1:5176/?view=workspace`。
- 检查空间 Tab 能加载。
- 检查空间派活能写入日志。
- 检查空间内专家团能按成员写入日志。
- 检查专家团回执不伪造完整回答，只展示真实 response_preview / 投递状态。
- 检查 Console 无业务异常。
- 检查 Network 无失败请求。
- 截图并用视觉检查确认移动端布局不崩。

7. Git 稳定点。

```bash
git status --short
git diff --check
git add <改动文件>
git commit -m "feat: 补齐空间结果回流"
```

## 风险点

1. `sent.jsonl` 中的 `response_preview` 可能只是一小段预览。
   - 风险：专家团回执看起来像完整回答。
   - 处理：UI 文案必须写「回执预览」，不能写「专家结论」。

2. 通过空间名称匹配任务可能漏掉改名后的空间。
   - 风险：空间改名后旧任务无法命中。
   - 处理：本轮不做空间改名；后续如做改名，需要给空间增加稳定 `spaceId` 并写入消息上下文。

3. 继续使用 `localStorage` 会导致换设备后空间列表不同步。
   - 风险：手机和电脑看到的空间不一致。
   - 处理：当前阶段接受；真正多设备同步时再引入后端存储。

4. BFF 45 秒超时会让移动端按钮等待更久。
   - 风险：用户以为卡住。
   - 处理：前端按钮必须显示「正在派活」状态；后续可改为后端异步投递。

5. 批量补投可能把历史测试消息重新发送给 Agent。
   - 风险：污染真实会话。
   - 处理：继续保留一次 1 条补投，默认不自动批量 replay。

6. 启动脚本如果自动拉起 Hermes gateway，可能和已有 gateway 重复。
   - 风险：端口冲突或重复进程。
   - 处理：脚本必须先检查端口，已监听则跳过，不杀已有进程。

7. 底部 Tab 可能遮挡长页面最后一个卡片。
   - 风险：用户在手机上看不到空间日志底部。
   - 处理：在 `styles.css` 中给 `.app-shell` 或页面底部增加足够 `padding-bottom`，并用 390×844 与 320px 宽度截图验证。
