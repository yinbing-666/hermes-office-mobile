# Hermes Office CostPage 改造任务书

你是高级前端工程师。请 review 并改造 `/home/agentuser/projects/hermes-office-mobile` 的成本统计页面（CostPage），让它展示真实的 Token 消耗，而不是调用次数。

## 用户痛点（原话）

「那个 token 啊，你直接就计算每天用量是多少 token，然后命中缓存多少，用了哪些模型就行了，而不是像现在这样调用多少次，我都不知道花了多少实际上」

## 项目背景

- 移动端优先 PWA，Marvis Office 浅色办公风：米灰/白底、1px 边框、克制圆角、线性图标、无 emoji、无重阴影
- 前端：React + Vite + TypeScript，主要文件 `frontend/src/App.tsx`（CostPage 在约 1009-1070 行）、`frontend/src/types.ts`、`frontend/src/styles.css`
- 后端：`backend/main.py`（FastAPI），已有两个接口

## 后端已有数据（不要改后端，除非必须）

1. `GET /api/token-usage` 返回今日数据：
```json
{
  "ok": true, "available": true, "date": "2026-08-10",
  "total": {
    "input_tokens": N, "output_tokens": N,
    "cache_read_tokens": N, "total_tokens": N, "saved_tokens": N, "api_calls": N
  },
  "by_model": [
    {"model": "deepseek-v4-flash-0731", "provider": "...", "input_tokens": N, "output_tokens": N, "cache_read_tokens": N, "api_calls": N, "last_seen": "..."}
  ]
}
```

2. `GET /api/usage/trend` 返回近 14 天（按天）：
```json
{
  "ok": true, "available": true,
  "days": [
    {"date": "2026-08-10", "input_tokens": N, "output_tokens": N, "cache_read_tokens": N, "api_calls": N}
  ],
  "total_calls": N
}
```

注意：**cache_read_tokens 就是命中缓存的 token 量**（prompt caching 节省的 token）。saved_tokens = cache_read_tokens。

## 改造要求（重点）

### 1. 顶部 summary 卡（growth-summary）
现在显示：「近 14 天调用」(totalCalls)、「今日输入」、「今日输出」。
改成以 **Token 为主**的四个指标：
- **今日总 Token**：total_tokens（input + output）
- **今日输入**：input_tokens
- **今日输出**：output_tokens
- **今日命中缓存**：cache_read_tokens（显示成「缓存命中」或「缓存节省」）

调用次数降级为次要信息（可以在小字里保留，比如「近 14 天 N 次调用」放在描述行，不作为主数字）。

### 2. 趋势图（trend-chart）
现在按 `day.api_calls` 画柱子。改成按 **每日总 token**（input_tokens + output_tokens）画柱子，柱子上方显示 token 数（用 formatTokens 格式化，如 1.2K / 3.4M）。
标题从「近 14 天调用趋势」改为「近 14 天 Token 趋势」。
如果某天 cache_read_tokens 大，可以在柱子里叠加显示缓存占比（可选，如果实现复杂就不做，保持简单）。

### 3. 今日模型用量列表（model-usage-list）
现在按 `api_calls` 排序、柱条按 `api_calls` 比例、只显示「N 次调用」。
改成：
- **按 token 总量排序**（input_tokens + output_tokens 降序）
- 每个模型显示：模型名、provider、**总 token**（input+output）、**缓存命中 token**（cache_read_tokens）
- 柱条宽度按该模型 token 占总 token 的比例
- 每行右侧主数字是 token 量（formatTokens 格式化），调用次数放小字次要位置

### 4. 格式辅助
`formatTokens(value)` 已存在于 App.tsx（约 1005 行）：
```ts
if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
return String(value);
```
直接用，不要重造。

## 风格约束（铁律）

- 保持 Marvis Office 浅色风格：米灰/白底、1px 边框、克制圆角、线性图标
- **不用 emoji**，不用重阴影，不用玻璃拟态
- 改动只限于 CostPage 相关的 JSX、types、CSS。不要动其他页面（Office/Evolution/Sessions 等）
- **🚫 硬约束（违反即失败）**：
  - 禁止删除或修改任何 tab（办公室/员工/进化/知识库/成本/空间/选题/工作流/任务 等现有 tab 结构一律不动）
  - 禁止删除任何页面/组件/模块（WorkflowPage、Workspace、Outbox、Topics、Delegation 等现有功能全部保留）
  - **禁止修改 backend/main.py**（后端已经够用，只改前端）
  - 禁止重构 import / 删类型定义 / 改 avatar 路径 / 动与 CostPage 无关的代码
  - 只做「把 CostPage 的展示从调用次数改成 token 量」这一件事
- 如果 types.ts 里 TokenUsageData / UsageTrendData 缺字段，补上
- 不添加新的 npm 依赖

## 验证

1. `cd frontend && npm run build`（或项目实际的 build 命令，见 package.json）必须通过，无 TS 错误
2. 手动检查 CostPage 的 JSX 逻辑：空数据时（days.length === 0 / byModel.length === 0）不能崩
3. 不要启动后端，不要部署，只改代码 + build 验证

## 输出

回复里写：
1. 改了哪些文件、每个文件改了什么
2. build 验证结果
3. 你发现的前端其他明显问题（一句话一条，可选的 review 意见）
