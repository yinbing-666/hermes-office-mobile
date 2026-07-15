# Hermes Office Mobile

移动端 Hermes 可视化办公室，用来管理小黑、小橙、小金三个 AI 员工。

## MVP 闭环

- 办公室首页：展示 Agent 状态。
- Agent 详情：展示 profile、端口、SOUL.md / AGENT.md 状态。
- 派活入口：把任务写入 `backend/runtime/outbox.jsonl`，形成最小可验证闭环。
- 进化档案：展示最近 Skills 和 profile 人格文件更新时间。
- 任务动态：展示 Cron 和 gateway 活动。

## 启动

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
curl -sS -X POST http://127.0.0.1:8787/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"default","message":"测试任务"}'
```

## 当前边界

- v1 不直接调用 Hermes API Server，只写项目内 outbox。
- 不修改 Hermes core、gateway、config.yaml、.env 或密钥。
- 不公网暴露，默认本机访问。
