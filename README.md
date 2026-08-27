# 一级市场 · 前沿科技简报

每天早上自动生成一份网页版简报，围绕**中国一级市场前沿科技投资**这一个用途。
改造自 [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief)（MIT 协议）。

---

## 它长什么样

一个网页，顶部五个标签页，按重要性排序：

| 标签页 | 里面是什么 |
|---|---|
| **一级市场**（打开默认停在这里） | 国内创投（36氪快讯 / 创投主题 / 热榜、创业邦）+ 海外创投（TechCrunch 创投、Crunchbase、The Information、红杉、YC） |
| **前沿科技** | 中文科技媒体（量子位、雷峰网、极客公园、钛媒体、InfoQ、Solidot）、海外科技媒体、热门论文、X 推文热度榜、GitHub Trending |
| **深度观察** | 虎嗅商业长文 |
| **二级参照** | 7 个标的，只用来读环境：纳斯达克 / 恒生科技 / 科创50（退出窗口）、费城半导体 / 英伟达（技术风向）、10Y 美债 / 美元人民币（估值锚） |
| **宏观政策** | 国家统计局、华尔街见闻、东方财富、BBC World |

网页最上方是 AI 生成的当日总览和精选条目，下面是各源原始列表。

---

## 和原版比，改了什么

1. **信源全换了**。原版偏硅谷科技 + 二级市场，现在是 27 个源，以简体中文为主，重心在一级市场融资动态。
2. **股票列表从 21 个砍到 7 个**。你不炒股，所以去掉了个股和加密货币，只留能反映"退出窗口开没开、算力景气度如何、折现率多高"的指标。
3. **AI 的分析视角换了**。原来是"新闻编辑"，现在是"服务一级市场投资人的研究助理"——写融资消息时会强制补全**轮次、金额、投资方、公司在做什么**四要素，原文没写的一律不编。技术新闻会点出商业化含义对应哪条赛道。政策新闻会说明传导路径。
4. **板块重排**，一级市场放第一位。

> 每个信源为什么选它，都写在 `sources.config.json` 每条的 `notes` 字段里。

---

## 怎么让它跑起来

### 你需要准备的唯一一样东西：一个 AI 的 API key

推荐 **DeepSeek**（便宜、中文好，一个月不到 1 美元）：去 [platform.deepseek.com](https://platform.deepseek.com) 注册 → 充值几美元 → 在 API keys 页面生成一个 key，是一串 `sk-` 开头的字符。

> 这一步必须你自己做，涉及注册和支付信息。

### 部署（全程在网页上点，不需要在自己电脑装任何东西）

1. **把这个项目传到 GitHub**
   在 GitHub 新建一个仓库（**必须选 Public**，因为免费账户的网页托管功能只对公开仓库开放），然后在本目录执行：

   ```bash
   git remote add origin https://github.com/你的用户名/仓库名.git
   ```

   ```bash
   git push -u origin main
   ```

2. **允许它自动运行**
   仓库页面 → Settings → Actions → General → 找到 Workflow permissions → 选 **Read and write permissions** → Save

3. **填入你的 key**
   仓库页面 → Settings → Secrets and variables → **Actions**
   - 在 **Secrets** 标签点 New repository secret：名字 `DEEPSEEK_API_KEY`，值填你的 key
   - 在 **Variables** 标签点 New repository variable：名字 `REPORT_TZ`，值填 `Asia/Shanghai`

   > ⚠️ 两个最容易踩的坑：
   > 一是走错页面——必须从左栏「Secrets and variables → Actions」进，**不要从「Environments」进**，那是另一套配置，运行时读不到。
   > 二是输入 `DEEPSEEK_API_KEY` 时中文输入法会把下划线变成全角 `＿`，一定要切英文输入法。
   >
   > 本项目的默认后端就是 DeepSeek，所以**不需要**额外加 `LLM_BACKEND` 变量。换别家才要加。

4. **手动跑一次**
   仓库 Actions 标签 → 第一次进来会有黄条提示，点 **"I understand my workflows, go ahead and enable them"** → 左边选 "Daily Brief" → 右边 **Run workflow**

5. **打开网页托管**
   等第 4 步跑完（约 5-8 分钟，绿色对勾表示成功）→ Settings → Pages → Source 选 "Deploy from a branch" → 分支选 `gh-pages`，路径 `/ (root)` → Save

   > `gh-pages` 这个分支要跑成功一次之后才会出现，所以顺序不能反。

跑完后，简报在 `https://你的用户名.github.io/仓库名/`，之后**每天早上 8 点（北京时间）自动更新**。

---

## 日常想改什么

| 想做的事 | 改哪里 |
|---|---|
| 加一个信源 | `sources.config.json` 里照着已有的格式加一条 |
| 关掉一个信源 | 把那条的 `"enabled": true` 改成 `false`（不用删） |
| 换触发时间 | GitHub Variables 加 `REPORT_HOUR`，比如 `8,18` = 早晚各一次 |
| 只在工作日出 | GitHub Variables 加 `REPORT_DAYS`，值填 `1-5` |
| 改股票列表 | `lib/trading/watchlist.ts` |
| 改 AI 的分析口径 | `lib/ai/prompts.ts`（当日总览）、`lib/ai/enrich.ts`（逐条摘要） |
| 改板块名字和顺序 | `lib/output/render.ts` 顶部的 `TEXTS_ZH` |

改完 `git push`，下次自动运行就生效。

---

## 已知的脆弱点

- **36氪那三个源走的是 RSSHub 公共镜像**（`rsshub.rssforever.com`）。36氪官方 RSS 已经下线，只能这么取。公共镜像可能限流或下线，**如果哪天 36氪的内容不见了**，把 `sources.config.json` 里那三条的域名换成 `https://hub.slarker.me` 或 `https://rsshub.ktachibana.party`，路径部分不动。
- **国家统计局的时间格式不标准**，程序可能读不出发布时间，导致它的条目在合并列表里排序靠后。内容还是会进报告。
- **中文源不会生成 AI 摘要**，直接显示原文摘录（这是有意为之，省钱，中文原文本来就能读）。如果想让中文源也过一遍 AI，把 `sources.config.json` 里对应条目的 `"lang": "zh"` 删掉即可，代价是每天多花一点 API 费用。
- **DW 中文源实测返回空**，已默认关闭。

---

## 原版文档

上游项目的完整说明保留在 [UPSTREAM-README.md](UPSTREAM-README.md)，二次开发指南在 [FORKING.md](FORKING.md)。

拉取上游更新：

```bash
git fetch upstream && git merge upstream/main
```

（我改过 `sources.config.json`、`render.ts`、`watchlist.ts`、`prompts.ts`、`enrich.ts`、`daily.ts`，合并时这几个文件可能冲突。）
