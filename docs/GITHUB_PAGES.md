# 使用 GitHub 免费发布前端

GitHub 仓库存放代码，GitHub Pages 发布网页。当前版本通过 Pages 运行，无需租服务器、购买域名或配置 AI 密钥。

## 第一次发布

1. 确认仓库的 **Settings → Pages** 中可使用 GitHub Pages。GitHub Free 的公开仓库支持 Pages；私有仓库是否支持取决于账号方案。如果页面提示需要付费，先停止，不升级付费方案，也不要直接将含有个人资料的仓库改为公开。
2. 在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。这一步需要仓库管理员权限。
3. 将应用代码以及 `.github/workflows/pages.yml` 提交到 `main`。只提交代码；原始对话、个人记录、导出备份和密钥不能放进仓库。
4. 打开 **Actions → Publish GitHub Pages**，查看自动运行结果；也可以点击 **Run workflow** 手动运行。
5. `build` 和 `deploy` 都成功后，打开部署记录中的网址。`TempleHao/codex` 未设置自定义域名时，预期地址为 **https://templehao.github.io/codex/**；实际地址以部署输出为准。

工作流使用 Node.js 24、锁文件安装、类型检查和单元测试，然后运行 `npm run build:preview`。构建后可选地读取微信读书，将加密阅读快照与只含状态、时间和固定错误码的文件加入 `preview-out/`，再上传静态目录。密钥、明文阅读资料和本机工作台记录不会进入发布文件。页面路径由 GitHub Pages 配置自动提供，支持仓库子路径和根路径。后续推送 `main` 会更新网页，并保留、合并已有加密快照；读取失败不发布半份资料，无法安全取回上一份快照时停止部署，避免覆盖历史。

微信读书同步仍只使用免费的 GitHub Actions 与 Pages，需要配置两个仓库 Secret，步骤见 [GitHub 微信读书同步](GITHUB_READING_SYNC.md)。工作流每天定时运行两次，也可用 **Run workflow** 手动更新；定时任务默认不读取笔记，手动运行时可勾选。GitHub 定时运行可能延迟。完成同步和部署后，网页仍需解锁、预览并确认保存。

无需个人访问令牌，工作流使用 GitHub 自动提供的权限。若首次运行提示找不到 Pages 配置，完成第 2 步后重新运行；若提示部署被拒绝，检查仓库的 Actions 策略及 `github-pages` 环境是否允许从 `main` 部署。

## 数据与使用范围

- 页面可以在 iPhone 和电脑上打开。人生看板、思考、事务与完整备份保存在**当前浏览器的本地存储**，不会自动上传 GitHub 或同步到其他设备。
- 可选微信读书同步发布口令加密的阅读快照，网页只下载本站文件。每台设备各自解锁并确认后保存；这不会上传或同步本机的人生看板、独立思考和事务。
- 整理好的待办可以粘贴、预览、编辑并保存。请用应用的备份导出功能保存文件，需要时在另一台设备导入。
- 清除网站数据、更换浏览器或使用隐私浏览可能导致记录丢失。网址或域名变更后，也需要从备份恢复。
- 网页界面、静态代码与已发布的加密快照公开可访问，请妥善保管随机长解锁口令。解锁后保存的个人记录留在本地浏览器；在共用设备上使用时，同一浏览器的其他使用者也能看到这些记录。
- Pages 提供静态前端，Actions 负责可选微信读书读取；当前没有账号、服务端工作台数据库、完整工作台跨设备自动同步或后台提醒。本版本不向外部 AI 服务发送原文。

GitHub Pages 在中国大陆的访问速度和稳定性需实测。先用免费 `github.io` 地址，无需购买域名；GitHub 的使用额度和政策仍然适用。

如果当前私有仓库不能免费启用 Pages，可以另建一个只含前端代码和虚构演示内容的公开预览仓库。这需要你决定是否公开代码，当前流程不会创建仓库或修改仓库可见性。

## 本地构建核验

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
LIFE_BASE_PATH=/codex npm run build:preview
```

导出目录为 `preview-out/`。发布完成应检查：页面和样式正确加载、整理结果可导入、刷新后待办仍存在、备份可导出与恢复。工作流文件或本地构建成功，均不代表公网部署已经成功；以 GitHub 部署结果和实际访问为准。

参考：[GitHub Pages 介绍](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[configure-pages](https://github.com/actions/configure-pages)、[upload-pages-artifact](https://github.com/actions/upload-pages-artifact)、[deploy-pages](https://github.com/actions/deploy-pages)。
