# UI-REFINE-CSS-BRIEF — 全局设计系统升级（纯 CSS，只改 styles.css）

## 背景
项目：/home/agentuser/projects/hermes-office-mobile（office.icewill.tech）
移动端优先的中文办公 Web App，480px 容器。本次只做视觉升级，目标是「大厂产品精致感」（参考腾讯 Marvis / Notion / Linear 的浅色克制风）。

## 你的权限
- ✅ 只改 `frontend/src/styles.css`（唯一文件，另一个窗口在改 App.tsx，不要碰任何 .tsx）
- 🚫 禁止动后端、禁止删 tab/模块、禁止加依赖、禁止改 HTML 结构

## 当前样式基线（styles.css :root）
```
--bg:#f6f7f5; --surface:#fff; --surface-soft:#f8f9f7; --surface-blue:#eef3f6;
--text:#1c1c1e; --muted:#6e6e73; --subtle:#70757a;
--line:#e5e7e5; --line-strong:#cdd1ce;
--blue:#416f91; --green:#39765a; --red:#9a5050; --amber:#8b6738;
--card-radius:10px; --card-shadow:0 1px 2px rgba(32,37,43,.035);
font: Inter + Noto Sans SC
```
文件 1432 行。涉及：topbar、login、卡片类(.office-overview/.home-focus-card/.quick-dispatch-card/.channel-health-card 等)、tabbar、统计网格、任务列表、cost 页、evolution/knowledge 页。

## 要解决的问题
1. 顶部栏信息过载：品牌+标题+用户状态+退出+连接状态5个信息点无主次
2. 底部 tab 图标简陋像草图，选中态辨识度弱
3. 阴影生硬、层次感差：--card-shadow 太弱（0 1px 2px .035），hover 又跳 0 2px 5px
4. 字号层级混乱（9px-22px 跳跃大），9px 浅灰文字对比度不足可读性差
5. 信息密度高拥挤缺留白，卡片 padding 不统一（10-18px 乱）
6. 色彩单一缺品牌色系统，数据网格数字与标签对比过强
7. 3D 插画卡片与扁平 UI 冲突（样式层面可加过渡/边框/标题区分离）

## 硬约束（违反=作废）
- ❌ 不用 emoji、不用重阴影（box-shadow 不超过 0 8px 24px rgba 且 alpha≤.08）、不用玻璃拟态/backdrop-filter、不用渐变堆砌、不加花哨动画
- ✅ 保持浅色办公风（米灰/白底）、1px 边框、克制圆角（6-12px）
- ✅ 中文界面，字号建议：页面标题 20-22px/650、区块标题 15-16px/600、正文 13px、辅助 11px、caption 10px（当前 9px 最小字号提升到 10px）
- ✅ 间距阶梯统一：4/8/12/16/20/24
- ✅ 品牌色建议：主色一个（蓝或绿选一，从 #416f91 或 #39765a 优化成更现代的值），配同色系 soft 背景，语义色（成功/警告/错误）保持克制
- ✅ 保留现有 class 名（其他窗口在用），只改样式不改类名

## 交付要求
1. 升级 :root 设计 token（色板/字号/间距/圆角/阴影，具体数值）
2. 重写 topbar 样式（收敛信息层次）
3. 统一卡片系统：padding、标题区、分隔线、hover 反馈
4. 重写 tabbar 样式（选中态、图标容器、安全区）
5. 提升 9px 字号 → 10px 起，浅灰文字对比度修复
6. 数据网格平衡（数字/标签比例）
7. 其他页面（cost/evolution/knowledge）的排版统一

## 验证
```bash
cd /home/agentuser/projects/hermes-office-mobile/frontend && npm run build
```
必须通过。不要改动任何 .tsx 文件。完成后 git status 确认只改了 styles.css。
