# GitHub 仓库资料

完整项目介绍见 [README](../README.md)，版本历史见 [Releases](https://github.com/TempleHao/codex/releases)。以下是仓库首页右侧 **About → 设置** 可直接填写的资料。当前 Codex GitHub 集成修改仓库设置时返回 `403 Resource not accessible by integration`；这不影响代码提交、Pages 或工作流内的版本发布，需要仓库维护者在网页填写这些字段。

## Description

> 有序 · 人生工作台：面向 iPhone 和电脑的中文个人人生应用，梳理生活线索、经历与回顾，整合阅读、影音、思考和事务。GitHub Pages 免费部署，支持微信读书与 Trakt，资料默认保存在本机浏览器。

## Website

https://templehao.github.io/codex/

Fork 后使用自己的 Pages 网址。

## Topics

```text
life-workbench personal-dashboard life-journal wechat-reading trakt github-pages nextjs typescript chinese-language
```

维护者使用具有仓库设置权限的 GitHub CLI 时，也可以运行：

```sh
gh repo edit TempleHao/codex \
  --description '有序 · 人生工作台：面向 iPhone 和电脑的中文个人人生应用，梳理生活线索、经历与回顾，整合阅读、影音、思考和事务。GitHub Pages 免费部署，支持微信读书与 Trakt，资料默认保存在本机浏览器。' \
  --homepage https://templehao.github.io/codex/ \
  --add-topic life-workbench --add-topic personal-dashboard --add-topic life-journal \
  --add-topic wechat-reading --add-topic trakt --add-topic github-pages \
  --add-topic nextjs --add-topic typescript --add-topic chinese-language
```
