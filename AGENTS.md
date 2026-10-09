<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 工作预检与用量控制

用户要求减少无效 Token 消耗。开始新步骤前，先确认目标、已有证据、尚未解决的问题，以及能解决问题的最小下一步；复用已读文件、已有诊断和已完成验证，避免重新调查已确认的问题。

只有子任务独立、分工明确且能节省时间或提高结果质量时才分派智能体；交接只提供必要的背景、文件范围和验收标准，避免多人重复阅读、检查或修改同一问题。没有明确收益时由当前智能体集中处理。

搜索与读取尽量批量进行，限制输出到相关片段。先定位失败原因再修改，不凭猜测反复发布。测试按改动范围选择；同一版本已经通过的检查不重复运行，除非新改动、失败或未解决风险需要重新验证。发布后的检查仍须区分构建成功和实际功能成功。

## 模型选择

用户授权按任务复杂度为子智能体选择可用模型与推理档位，不默认使用最高档。主对话的模型与档位由 Codex 设置控制，智能体不得声称能自行切换主对话模型或保证实际计费额度。

- 简单且独立的查询、文档整理、小范围核对：优先 `gpt-6-luna`，`low` 推理。
- 一般开发或有明确边界的排查：优先 `gpt-6.1-sol`，`medium` 推理。
- 跨模块设计、复杂故障或需要深入判断的问题：使用 `gpt-6.1-sol` 或 `gpt-6-astra`，从 `high` 推理开始；只有具体难点需要时才升档。

不要为了切换模型把简单任务另行分派；当前智能体直接完成通常更省。分派时只交接任务所需背景，不复制无关历史。先用足够解决问题的最低档，证据表明能力不足时再升级，避免反复尝试消耗更多。压缩重复工作和交接开销，保留必要的资料保护与功能验证。

## 项目介绍与每次版本更新

用户要求完整维护 GitHub 项目介绍，并为每次更新发布版本。每次向 `main` 发布代码、样式、配置或文档修改时，同步提升 `package.json` 与锁文件版本，在 `CHANGELOG.md` 新增实际日期和具体变更，更新 README 的版本及相关指南。修复或文档更新用 patch，较大功能用 minor；定时资料同步和同提交重试不改软件版本。遵循 [版本发布指南](docs/RELEASING.md)。

先执行 `npm run release:check` 和范围合适的验证，再完整提交。Pages 成功部署后工作流自动发布 GitHub Release；结束前检查部署、Release 和实际网页版本，不能只说“已提交”。已发布标签不移动或覆盖；不补造历史版本，不将个人资料或加密阅读快照添加为 Release 附件。维护介绍时准确区分已有能力和后续方向，不默认选定未获用户授权的许可证。
