# ROADMAP

Hermes Office Mobile — 面向本地 Hermes Agent 安装的移动优先办公工作台（React PWA + FastAPI BFF）。

## 阶段

- **当前阶段**：核心功能稳定，代码可公开使用；依赖版本与 CI 门禁持续完善中。
- **完成度**：本地数据展示（agents/tasks/knowledge/cost/workflows）与消息投递主链路可用；本地认证（scrypt 口令 + 服务端会话 + CSRF + 限流）已实现并有测试覆盖。

## 已完成

- React PWA 移动优先工作台（安装、离线壳、桌面/移动双端布局）
- FastAPI BFF：读本地 Hermes 配置、日志、任务、状态库；同源 `/api/*`
- 本地认证：`local` 模式（口令 + 会话 + CSRF + 按身份限流 + 脱敏审计），`disabled` 模式默认关闭
- 消息投递：Hermes API 主路径 + outbox 兜底 + 原子写入
- 成本/Token 统计、知识主题与图谱、工作流工作室等视图
- Cloudflare Worker 只读 topics 缓存（KV）

## 进行中

- 依赖版本固定（frontend `latest` → 具体版本；backend requirements pin）
- 可复现构建与 CI（前端 `tsc --noEmit`、后端 pytest）
- 去除对个人环境的强依赖（`~/.hermes` 目录、默认模型/域名），提供 mock 与示例配置

## 待办

- 公开版部署文档（示例域名、环境变量说明）
- 独立于 Hermes gateway 的 mock BFF 运行模式
- 安全加固：默认 `HERMES_AUTH_MODE` 改为 `local` 的部署向导

## 最近验证

- 后端安全模块测试（本地认证/访问安全）通过
- 前端 TypeScript 类型检查通过，生产构建成功
- 隐私清理完成：仓库不再包含个人知识库数据、内部运维文档、真实域名与凭据
