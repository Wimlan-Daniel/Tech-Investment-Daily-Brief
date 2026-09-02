# 关于 GitHub Actions

本项目采用**本地部署**：简报在个人电脑上生成（通过 Claude Code 命令行复用订阅额度），
再由 `scripts/publish.mjs` 推送到 GitHub Pages。

上游项目自带的 `workflows/daily.yml` 已删除——它是给「在 GitHub 服务器上跑整条流水线」
那种部署方式用的，需要 `ANTHROPIC_API_KEY` 之类的密钥，而本地部署没有也不需要。
留着它只会每小时触发两次（cron `:07` 与 `:37`）并全部失败，给仓库主人刷一堆报错邮件。

将来若要改成 GitHub Actions 部署，从上游取回该文件并配置对应的 Secrets：
https://github.com/leiting-eric/DailyBrief/blob/main/.github/workflows/daily.yml
