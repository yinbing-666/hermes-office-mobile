# Hermes Office Mobile

> Mobile-first PWA for managing the user's Hermes multi-agent office: 小黑、小橙、小金.

## 技术栈
| 层 | 技术 | 说明 |
|---|---|---|
| Frontend | Vite + React + TypeScript | Mobile-first PWA |
| UI | Tailwind CSS + custom components | Warm Minimal + office card style |
| Backend | FastAPI BFF | Read local Hermes profiles/logs/status and proxy future Hermes API calls |
| Storage | Existing Hermes files/logs + JSON fallback | v1 does not introduce database |

## MVP 范围
- 办公室首页：展示小黑、小橙、小金三个 AI 员工状态。
- Agent 详情页：角色、端口、最近活动、消息输入占位。
- 进化档案页：Skills/Memory/日志变化的摘要占位。
- 任务动态页：Cron 和 gateway 活动摘要。

## 不做
- 不修改 Hermes core。
- 不修改 ~/.hermes/config.yaml、.env、密钥或 gateway 服务。
- 不暴露公网，不处理 Cloudflare。
- 不做完整聊天历史和复杂工作流画布。

## 运行
- Backend: `cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8787`
- Frontend: `cd frontend && npm install --registry=https://registry.npmmirror.com && npm run dev`

## ADR-001: Vite React PWA + FastAPI BFF
**决策**：使用 Vite React PWA 作为移动端外壳，FastAPI 作为 Hermes 本机数据聚合层。  
**原因**：轻量、AI 熟悉、适合 mobile-first；不改 Hermes 核心，降低风险。  
**代价**：第一版不直接替代官方 Desktop，仅作为个人办公室控制台。  
**日期**：2026-07-15
