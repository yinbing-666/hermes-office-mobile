# ROADMAP

## 当前阶段

MVP v2.1：根据 Grok review 完成第一轮“接线与诚实”修复。工作流已接入主导航，但当前明确为模拟模式；后端保存从 append-only jsonl 改为按 id upsert 的 `workflows.json`，执行接口返回 `mode: simulated`，不再伪装已代理到 Hermes。

## 已完成

- (所有之前已完成项保持不变)
- 完成 Marvis Office 风格 UI 第三刀：新增「工作流」Tab + 拖拽画布 + 节点面板 + 属性面板 + 模拟运行
- 最小MVP 拖拽节点工作流生成器（节点、连线、属性编辑、localStorage 草稿缓存、模拟运行）
- 工作流已接入主导航，入口不再悬空
- 后端 `POST /api/workflows` 改为按 id upsert 保存到 `workflows.json`，兼容旧 `workflows.jsonl`
- 后端 `POST /api/workflows/execute` 明确返回 `mode: simulated`，不会伪装真实调用 Hermes
- 样式完全统一到 Marvis Office 浅色办公风（浅米灰、1px 边框、克制圆角、线性图标、无 emoji）
- 使用 useMemo + useCallback 优化渲染性能
- 浏览器真实验证通过（拖拽、连线、编辑、运行、Console 无错误、网络正常）
- 清理 mprss 相关代码，集成龙虾浏览器作为远程 UI 验收节点

## 最近验证

- 2026-07-17：`cd frontend && npm run build` 通过（258KB JS，无 TS 错误）
- 浏览器验证（localhost:5176/?tab=workflow）：拖拽正常、连线正常、属性编辑正常、模拟运行正常、移动端适配正常
- 龙虾远程验收节点可正常触发（Tailscale 访问龙虾浏览器验证 UI）
- Console 和网络请求检查：无错误

## 下一步

1. v2：实现最小真实执行引擎，只接 `start → hermes_call → end`，复用现有 `POST /api/messages`、sent/outbox 和任务动态。
2. v3：增加工作流版本管理、专家团节点、空间上下文注入和简单并行节点。
3. 每次迭代后 build + API 烟测 + 浏览器验证 + 更新 ROADMAP。

## 暂不做

- 不做公网部署
- 不做完整聊天历史
- 不接数据库
- 不增加后台常驻服务

（本文件已按 incremental-implementation skill 要求，在每个主要增量后更新）
