# UI-REFINE-TSX-BRIEF — 结构与图标升级（纯 TSX，只改 App.tsx / OfficeIcon.tsx）

## 背景
项目：/home/agentuser/projects/hermes-office-mobile（office.icewill.tech）
移动端优先的中文办公 Web App，480px 容器。本次只做视觉升级，目标是「大厂产品精致感」（参考腾讯 Marvis / Notion / Linear 浅色克制风）。

## 你的权限
- ✅ 只改 `frontend/src/App.tsx` 和 `frontend/src/components/OfficeIcon.tsx`（另一个窗口在改 styles.css，不要碰任何 .css）
- 🚫 禁止动后端、禁止删 tab/模块、禁止加依赖、禁止改功能逻辑、禁止改 types.ts/api.ts

## 现状
- App.tsx 1416 行。Tab 类型：'office' | 'agent' | 'evolution' | 'knowledge' | 'cost'，tabs 数组在 91 行附近（5 个：办公室/员工/进化/知识/成本）
- OfficeIcon.tsx 是项目自己的图标组件（有 office/agent/evolution/knowledge/cost 等图标），禁止从 lucide-react 独立导入
- 首页结构：topbar（品牌 HERMES OFFICE + 标题 + 用户状态 + 退出 + 连接状态）→ 今日办公室 3D 插画卡片 → 统计网格 → 今日待处理任务 → 底部 tabbar
- 3D 插画是 img（office-scene.webp 或类似），三个工位标注

## 要解决的问题
1. 顶部栏信息过载：5 个信息点（品牌+标题+用户状态+退出+连接状态）无主次，需要收敛结构（例如：主标题区只留标题+连接状态，用户状态/退出收敛到右上角小图标或移入其他区域；具体方案你定，但必须保留全部功能入口）
2. 底部 tab 图标简陋：OfficeIcon 里 5 个图标（office/agent/evolution/knowledge/cost）线条粗糙，需要重绘为更精致的 24x24 线性图标（描边 1.5px、圆角端点、视觉重量一致），选中态与未选中态区分明显
3. 3D 插画与扁平 UI 冲突：插画卡片内工位标注样式生硬（样式类名保留，结构可调），标题区与图片需要视觉分离
4. 统计网格数字与标签对比过强（数字过大破坏平衡）——结构调整可加层级类

## 硬约束（违反=作废）
- ❌ 不用 emoji、不加花哨动画/渐变、不用玻璃拟态、不删任何功能入口、不删 tab
- ✅ 保持浅色办公风，中文界面
- ✅ 图标用 SVG 手绘（stroke 1.5、round linecap/linejoin、24x24 viewBox），风格统一：办公室=建筑/桌面、员工=人像、进化=趋势线、知识=书本、成本=货币/图表
- ✅ 类名沿用现有命名（另一个窗口在改 CSS），如果你需要新类名，用语义化名称（如 .topbar-user、.tab-icon）

## 交付要求
1. 顶部栏结构收敛（保留所有功能入口，布局更清爽）
2. OfficeIcon.tsx 5 个 tab 图标重绘（精致线性风格）
3. 今日办公室插画卡片结构微调（标题区/图片/工位标注分离）
4. 统计网格层级调整（如需）
5. 不引入新依赖，不删功能

## 验证
```bash
cd /home/agentuser/projects/hermes-office-mobile/frontend && npm run build
```
必须通过。完成后 git status 确认只改了 App.tsx 和 OfficeIcon.tsx。
