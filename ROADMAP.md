# ROADMAP

## 当前阶段

MVP v2.5：移动版运行于 `https://office.icewill.tech`，前端通过同源 `/api/*` 访问本机 BFF。2026-08-02 已上线本地单管理员登录，未登录用户只能访问 session 与登录入口，业务 API 由服务端会话保护；Tailscale SSH 作为独立恢复通道。


## 已完成

- 完成本地登录与 Tailscale 恢复：scrypt 密码记录、服务端会话、admin 授权、严格 Origin、CSRF、幂等、登录／业务限流、脱敏审计、登录页和交互式密码管理；已于 2026-08-02 上线
- 完成 Marvis Office 风格 UI 第三轮迭代：新增「工作流」Tab、拖拽画布、节点面板、属性面板和模拟运行
- 完成最小 MVP 拖拽节点工作流生成器，支持节点、连线、属性编辑和 localStorage 草稿缓存
- 工作流入口已接入主导航
- 后端 `POST /api/workflows` 按 id upsert 到 `workflows.json`，并兼容旧 `workflows.jsonl`
- 后端 `POST /api/workflows/execute` 明确返回 `mode: simulated`，不伪装为真实 Hermes 调用
- 前端统一为浅色办公风，并使用 `useMemo`、`useCallback` 优化相关渲染
- 工作流拖拽、连线、属性编辑和模拟运行已完成浏览器验证
- 已清理 mprss 相关代码，并接入远程浏览器验收节点
- 后端只读接入 `~/.hermes/kanban.db`，新增 `GET /api/kanban/tasks`
- `GET /api/tasks` 聚合 Kanban 任务，状态映射含独立 `blocked`
- 前端任务页新增阻塞统计、筛选、详情看板字段与样式
- `~/.hermes/scripts/kanban_auto_block.py`：幂等 create→block --kind
- tool-wrapper：clarify 自动镜像 blocked 卡
- Kanban 任务返回 `kanban_id/session_id/action_url`，任务详情展示看板 ID 与会话
- 任务页阻塞提醒条：显示首个 blocked，可筛选阻塞，可一键跳到对应员工页
- SOUL / kanban skill 文档同步阻塞可见性规则
- README / ROADMAP 同步
- **v2.5：Topics 选题功能**
  - `GET /api/topics`：读取 `/tmp/topics_{date}.md`，动态日期，含 topics/agents/experts 聚合
  - TopicsPage 前端标签页：平台着色（公众号/小红书/抖音/B站）、价值标签、理由
  - `GET /api/experts/summarize`：聚合同 batch 三条专家回复，LLM 合成结论（已修 batch_id 锁定 bug、死代码删除）
  - `GET /api/kanban/unblock`：task_id 白名单正则校验 `^[a-z0-9_-]{1,64}$`，非 shell subprocess 执行
  - `/api/topics` 末尾加 title 校验，修无标题残留 bug
  - 同步 urllib 改 run_in_executor，避免阻塞 async 事件循环
- **v2.5 安全修复**
  - `/api/experts/summarize` batch_id None 时锁定第一个 bid，防止跨批混数据
  - `/api/topics` 日期动态计算，移除硬编码
- **2026-07-31 BFF 公网恢复**
  - 修复用户级 `hermes-office-mobile-bff.service`：移除导致 `status=216/GROUP` 的 `User=agentuser`
  - 服务已启用并保持 `active (running)`，监听 `127.0.0.1:8787`
  - `office.icewill.tech` 前端继续使用同源 `/api/*`，无需修改前端 API 地址

## 最近验证

- 2026-08-02：按主人确认新增并安装项目内 systemd drop-in 模板，设置 `HERMES_AUTH_MODE=local` 与严格允许来源后重启 BFF；新进程 active，本机与公网匿名 `/api/session` 返回 `auth_enabled=true`、`auth_mode=local`、`authenticated=false`，匿名业务 API 返回 401。使用独立保留 IP 验证错误密码前 5 次统一 401、第 6 次 429 且 `Retry-After=900`；主人在应用内浏览器完成正确登录，页面显示管理员身份，刷新后会话保持且业务数据正常，退出后 session 被撤销并持续返回登录页。最终 41 个后端测试、`py_compile`、前端 `npx tsc --noEmit` 与 `git diff --check` 通过；认证、会话和审计文件均为 `0600`，审计不含邮箱正文或测试密码。
- 2026-08-02：主人通过可见 PowerShell 和 Tailscale SSH 隐藏输入本地管理员密码两次，`manage_local_auth.py` 返回密码已更新且旧会话已撤销。只读复核确认配置状态为已设置、管理员邮箱为脱敏 QQ 邮箱，`runtime/local-auth.json` 与 `runtime/sessions.json` 均为 `0600` 且属于 `agentuser`，sessions 内容为空；密码正文未进入聊天或验证输出，BFF 仍保持 `disabled`。
- 2026-08-02：按主人确认执行 `frontend/make gate` 并发布登录前端；首次浏览器验收发现会话检查期间短暂渲染密码框，已改为纯“正在确认登录状态”页面后重新构建。公网 HTML 与服务器 `dist/index.html` 哈希一致，新资源 `index-BoFjgAtI.js`、`index-BR9NP6iU.css` 均返回 200；浏览器确认加载阶段无密码框，随后在 `disabled` 模式直接进入员工页并显示“鉴权待启用”，控制台无警告或错误。发布前构建备份保留于 `/tmp/hermes-office-mobile-dist-pre-auth-20260801T165906Z`。
- 2026-08-02：按主人确认重启 `hermes-office-mobile-bff.service`，新进程继续使用默认 `HERMES_AUTH_MODE=disabled`；本机与公网 `/api/health`、`/api/session` 均返回 200，session 明确为 `auth_enabled=false`、`auth_mode=disabled`，本机 `/api/agents` 返回 200，登录／退出路由已加载。旧生产前端浏览器验收确认员工页可直接使用、无登录表单、控制台无警告或错误；未修改运行配置、未执行 POST。
- 2026-08-01：完成“本地登录＋Tailscale 恢复”源代码与文档，但未上线。后端新增本地密码、服务端会话、登录限流和交互式密码管理，前端新增会话门禁、登录页和退出；后端组合安全测试 41 个通过，`py_compile` 与前端 `npx tsc --noEmit` 通过。未设置真实密码，未修改 `.env` 或 systemd，未重启服务，未执行生产构建／发布，未调用线上 POST。
- 2026-08-01：完成 Access 安全代码但未上线；项目虚拟环境安装 `PyJWT[crypto]==2.13.0`，新增 20 个安全测试，覆盖错误 AUD、角色拒绝、CSRF、限流和幂等重放；后端 `py_compile`、`unittest` 与前端 `npx tsc --noEmit` 通过。未配置 Cloudflare、`.env` 或 systemd，未重启服务、未执行生产构建、未调用 POST。
- 2026-08-01：完成项目文档真实性修复，仅修改 `AGENT.md`、`README.md`、`backend/README.md`、`ROADMAP.md` 与 `docs/*.md`；明确公网生产链路、BFF 读写与凭证边界、GET／POST 副作用、outbox 48 小时保护、运维回滚和移动端验收。全仓 `git diff --check` 与 `frontend/make gate` 通过，验证过程未调用 POST，未修改业务代码、服务或生产配置。
- 2026-08-01 19:13：按主人确认将 APP 自动补投策略定为默认关闭；活动 outbox 的 29 条 7 月 15 日旧消息已逐字节备份到 `backend/runtime/outbox.archive-20260801T111238Z.jsonl` 后清空，接口返回 `count=0`；Kanban 卡 `t_bda9e025` 已记录决策、解除阻塞并完成。
- 2026-08-01：服务器源代码完成移动端横向溢出、异步加载态、选题空态重试、发送结果未确认态、旧 outbox 48 小时保护与工作流 Pointer Events 修复；`frontend/make gate`、后端 `py_compile` 通过，BFF 重启后 `/api/health` 返回 200；29 条旧消息在默认重试模式下全部跳过，未触发真实投递。前端新构建已写入 Nginx 线上根目录 `frontend/dist`，公网 HTML 哈希与服务器一致，加载 `index-DHSqM2ZH.js`；390×844 公网验收确认无页面横向滚动、旧消息自动补投被拦截、选题空态可重试、工作流模拟无弹窗且控制台无错误。
- 2026-07-27：`/api/topics` 返回 3 topics（2026-07-26 文件），npm build 通过
- 2026-07-27：`/api/kanban/unblock` task_id 白名单校验通过，恶意注入返回 422
- 2026-07-27：BFF 重启正常，`npm run build` 通过
- 2026-07-31：用户级 BFF service 移除无效 `User=agentuser` 后启动成功，systemd 状态 `active (running)`，内存约 39.5 MB
- 2026-07-31：本机及公网 `GET /api/health` 均返回 200；公网 `agents/tasks/evolution/topics/workflows` 均返回 200
- 2026-07-31：`backend/.venv/bin/python -m py_compile backend/main.py` 与 `frontend/npm run build` 通过
- 2026-07-31：Codex 使用 `--dangerously-bypass-approvals-and-sandbox` 完成复核，确认无额外启动代码修复；CORS 不是鉴权，公开写接口的访问控制需单独立项
- 2026-07-31：复用小橙 Playwright Chromium 完成 390×844 公网页面验收；页面及小黑/小橙/小金正常渲染，`health/agents/tasks/outbox/evolution` 均返回 200
- 2026-07-31：任务页 390×844 本地生产构建验收通过：注入长 Gateway 日志后 `documentElement.scrollWidth=390`、七个底部导航 tab 均在 4–386px 视口内、任务标题与详情在卡片内截断；`npm run build` 通过，`frontend/public/favicon.svg` 已复制到 `dist/favicon.svg` 且 preview 返回 200
- 2026-07-31：办公室首页真实 Gateway 事件行公网验收通过：390×844 下 `innerWidth=390`、`documentElement.scrollWidth=390`、可见横向溢出元素 0、七个底部导航 tab 均在 9–381px 内；事件行内容收敛至 72–357px，应用控制台、页面异常与失败请求均为 0
- 2026-07-31：修复 PWA 静态资源 403 根因：`frontend/public/` 中 `favicon.svg`、`sw.js`、`manifest.json` 与图标原为 600，nginx 无权读取；统一为 644 后重新 build，公网资源全部 200，重复 build 后权限仍保持

## 已知问题

- 本地认证已上线并通过登录闭环验收；当前认证相关改动与既有脏工作区存在同文件交叉，Git 整理必须精确暂存，不能直接执行整仓 `git add -A`

## 下一步

1. 核对认证改动与既有脏工作区边界，精确暂存并单独提交本地认证，不纳入 Workflow、Worker、图标或分析产物等无关改动。
2. 补齐阻塞任务通知与跳转体验；任何 Kanban 状态修改仍需明确确认并保留审计证据。
3. 实现最小真实工作流执行引擎，只接 `start → hermes_call → end`，同时保持模拟态和真实态可辨识。
4. 每次迭代后执行构建、只读 API 烟测、浏览器验证并更新 ROADMAP；有副作用 API 单独确认。

## 判断库

- **真实性优先**：静态页面、缓存、模拟响应或本地入队不等于 Hermes 已执行；只有真实服务回执和可核验证据才能标记完成。
- **写操作需确认**：消息发送、outbox 补投、Kanban 修改、工作流写入／执行、生产发布和配置变更均需在执行前说明目标、影响与风险，并取得主人确认。
- **移动端不得横向溢出**：以 390px 宽视口为基础验收，页面根节点、导航、长任务标题和详情内容不得产生横向滚动。
- **模拟态不得伪装真实完成**：工作流 `mode=simulated` 只能显示“模拟完成”，不得展示为已调用 Hermes、已交付或已生成真实结果。
- **CORS 不是鉴权**：公网接口必须依赖独立的认证、授权和限流机制，不能用跨域配置代替安全控制。
- **默认烟测只读**：日常健康检查只调用 GET；任何 POST 烟测都按真实副作用操作处理。
- **实现不等于生效**：鉴权代码、依赖或测试存在，不等于线上已受保护；必须核对边缘策略、运行模式、服务进程和公网拒绝证据。


## 暂不做

- 不做完整聊天历史
- 不接数据库
- 不在 APP 内写入/改 Hermes Kanban 状态
- 不把 CORS 当作鉴权；公网写接口的认证/授权需单独设计和确认
