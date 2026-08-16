# Hermes Office Mobile

> Mobile-first PWA for managing the user's Hermes multi-agent office: 小黑、小橙、小金.

## 技术栈
| 层 | 技术 | 说明 |
|---|---|---|
| Frontend | Vite + React + TypeScript | Mobile-first PWA |
| UI | 原生 CSS + custom components | Warm Minimal + office card style |
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

## 协作规范（Vibe Coding × 前后端分工）

### 铁律：Plan First

**复杂任务（做错一次返工成本高）必须先出方案，再执行**：
1. 目标写结果，不写动作 → 「交付可运行的登录功能」而非「写一个登录页」
2. 同时给验收标准 → 响应速度、异常状态、测试用例
3. 找风险 → 复杂任务先说「哪里可能出问题」
4. 决策前让 AI 主动反对 → 「哪里会失败？什么假设最危险？」
5. **简单任务直接开干**，不需要先出方案

### 前后端分工

| 角色 | 负责 |
|---|---|
| Hermes（我） | 后端：API、数据库、部署、架构 |
| Gemini 网页端 | 前端 UI 修改（用户自己操作） |
| Codex/CC | 大改代码、批量重构 |

### 判断库（经验沉淀）

项目判断标准必须写入 ROADMAP.md「判断库」区块，包括：
- 什么结果算「好」：UX 标准、技术指标
- 什么情况必须推翻重来
- 本项目的常见踩坑

### 目标模式

大任务设成目标，让 AI 持续推进而非等一步做一步。每次只给下一步指令是大忌。

### 完成后必做

1. `make gate` 必须通过（build 失败不 commit）
2. 复盘：哪些步骤浪费了 Token？哪些流程可以自动化？
3. 把踩的坑写进 ROADMAP.md「已知问题」或「判断库」

（本规范整合自 Vibe Coding 50条经验 + 60天升级复盘）

## Git 工作流：Worktree 并行开发

### 何时用

需要 CC 和 Codex 同时开工（前后端分离改动）、或一个大功能需要拆多个方向同时开发时用 worktree。日常小改动直接改 master 即可，不需要 worktree。

### 分支命名规范

```
feature/<功能名>-frontend   前端改动分支
feature/<功能名>-backend    后端改动分支
feature/<功能名>            前后端都在 master 上改（单人小改动）
```

### Worktree 操作流程

```bash
# 1. 从 master 创建 worktree
git worktree add ../worktrees/feature-xxx-frontend feature/xxx-frontend
git worktree add ../worktrees/feature-xxx-backend  feature/xxx-backend

# 2. 在各自 worktree 开发
# frontend
cd ../worktrees/feature-xxx-frontend
claude ...   # 改前端代码

# backend（另一个终端）
cd ../worktrees/feature-xxx-backend
codex ...    # 改后端代码

# 3. 完成后合并回 master
git checkout master
git merge feature/xxx-frontend --no-ff -m "feat: frontend part of xxx"
git merge feature/xxx-backend  --no-ff -m "feat: backend part of xxx"

# 4. 清理 worktree
git worktree remove ../worktrees/feature-xxx-frontend
git worktree remove ../worktrees/feature-xxx-backend
git branch -d feature/xxx-frontend feature/xxx-backend
```

### 规范

- 所有 worktree 基于 `master`，不从其他 worktree 再开 worktree。
- 合并前各自 `cd ../worktrees/xxx && git pull origin master` 拉最新。
- commit 信息格式：`feat:` / `fix:` / `refactor:` 前缀，描述具体改了什么。
- 并行开发时，不同时改同一个文件。前端改 `frontend/src/`、`frontend/index.html`；后端改 `backend/main.py` 及 `backend/` 下其他文件。
- Worktree 目录统一放 `../worktrees/`，不在项目根目录散落。
