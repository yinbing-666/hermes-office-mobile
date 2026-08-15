# Hermes Office Mobile APP Review Brief

你是高级产品工程师和前端架构 reviewer。请 review 当前项目 `/home/agentuser/projects/hermes-office-mobile`。

## 背景
这是一个移动端优先的「Hermes Office / AI 员工工作台」PWA，偏 Marvis Office 浅色办公风：米灰/白底、1px 边框、克制圆角、线性图标、无 emoji、无重阴影。用户希望它成为小黑/小橙/小金等多 Agent 的移动办公入口。

## 当前重点
请重点看：
- frontend/src/App.tsx
- frontend/src/styles.css
- frontend/package.json
- backend/main.py 如存在
- README.md / ROADMAP.md

## Review 目标
请输出一份结构化 review，不直接改文件，只提建议。要求：
1. 产品定位和信息架构：这个 APP 现在像不像一个真正有用的 AI 工作台？哪里信息过载/不成体系？
2. 前端代码质量：组件边界、状态管理、类型、复杂度、可维护性。
3. UI/UX：移动端优先、Marvis Office 风格一致性、交互路径、视觉层级。
4. 工作流工作室：作为 MVP 是否有价值？下一步最该补什么？
5. 风险和 bug：列出可能真实影响使用的问题，按 Critical / High / Medium / Low 分级。
6. 三版迭代建议：
   - v1：1 天内能做的基础修正
   - v2：3 天内提升实用性的功能
   - v3：一周内可形成作品集亮点的升级

## 输出格式
用中文，精简但具体。每条建议尽量指向文件/模块。不要空泛说“优化代码”。
