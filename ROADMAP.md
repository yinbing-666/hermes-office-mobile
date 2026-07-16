# ROADMAP

## 当前阶段

MVP v2：新增「工作流工作室」Tab，实现最小MVP拖拽节点工作流生成器（类似 Coze 基础版），已完成并通过浏览器验证。Codex review 正在进行，之后将迭代三版。

## 已完成

- (所有之前已完成项保持不变)
- 完成 Marvis Office 风格 UI 第三刀：新增「工作流」Tab + React Flow 拖拽画布 + 节点面板 + 属性面板 + 模拟运行
- 最小MVP 拖拽节点工作流生成器（4 种基础节点、连线、属性编辑、保存到 localStorage、模拟运行）
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

1. Codex review 当前 MVP 代码（deleg_bbf35951 已派发）
2. 收到 review 结果后，我自己迭代三版（v1 基础完善、v2 增加执行引擎、v3 优化持久化和高级节点）
3. 每次迭代后 build + 浏览器验证 + 更新 ROADMAP

## 暂不做

- 不做公网部署
- 不做完整聊天历史
- 不接数据库
- 不增加后台常驻服务

（本文件已按 incremental-implementation skill 要求，在每个主要增量后更新）
