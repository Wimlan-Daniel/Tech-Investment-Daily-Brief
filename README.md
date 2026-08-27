# 前沿科技 · 投资简报

每天自动生成一份网页版简报，服务于**中国一级市场前沿科技投资**这一个用途。
改造自 [leiting-eric/DailyBrief](https://github.com/leiting-eric/DailyBrief)（MIT 协议）。

---

## 每天你会看到什么

一个网页，六个标签页：

| 标签页 | 内容 |
|---|---|
| **每日简报**（默认打开） | AI 跨板块精选 6-8 条当天最关键的，每条附一句「**为何重要**」——这件事影响哪条赛道、哪个判断 |
| **中国一级市场** | 融资、基金募集、并购退出、IPO、创投政策；海外重大事件也在这里 |
| **前沿技术** | 技术本身走到哪了：论文、能力突破、路线之争、开源动向 |
| **科技商业** | 技术变成生意了：发布、定价、客户、产能、供应链、公司动作 |
| **资本市场** | 上市公司与二级市场、宏观数据、利率汇率 |
| **全球商业** | 按《金融时报》头版标准筛的重大商业事件 |
| **环境指标** | 7 个指标读环境：纳斯达克/恒生科技/科创50（退出窗口）、费城半导体/英伟达（算力景气）、10Y美债/美元人民币（估值锚） |

每条资讯都标了 **第一手** 还是 **媒体报道**。

---

## 和原版最大的三点不同

### 1. 板块按「内容性质」分，不按「信源」分

原版是一个源固定属于一个板块。实测发现这行不通——36氪快讯同一天里既有「某公司完成 A 轮融资」（一级市场），也有「某上市公司上半年净利润 29 亿」（二级市场），还有「某游戏制作人离职」（纯噪音）。按来源分，三者会被塞进同一个板块。

所以加了一层 [`lib/ai/classify.ts`](lib/ai/classify.ts)：抓取之后、渲染之前，把每条交给模型判断真实归属，**顺便剔除噪音**。

副作用是以后想调整板块划分，改一段说明文字就行，不用重新找信源。

### 2. 每日简报页是新建的

原版**每天都在花钱生成简报，但从来没显示过**——`renderHtml` 只用了行情数据，简报只存在于默认不输出的 Markdown 里。现在它是第一个标签页。

简报相对下面各板块原始列表的增量，是每条的 `why` 字段：不重复摘要，只回答「所以呢」。

### 3. 信源换成中文为主 + 第一手优先

36 个启用源，其中 **18 个第一手**（OpenAI、DeepMind、Google Research、NVIDIA、Waymo、Mistral、CMU 机器人研究所、MIT News、国务院、国家统计局、红杉、YC 等官方渠道）、18 个二手媒体。

> 每个源为什么选它、有什么坑，都写在 [`sources.config.json`](sources.config.json) 每条的 `notes` 里。

---

## 怎么用

环境已经装好了（Node 在 `~/.local/node`，claude 命令行已登录）。

### 手动出一份简报

```bash
npm run daily
```

跑完后打开：

```bash
npm run open
```

### 让它每天早上 8 点自动跑

```bash
node scripts/install.mjs --at 08:00 --global
```

装完之后每天自动出。**电脑睡着不会被叫醒，但唤醒后会自动补跑**（这是 macOS launchd 的行为，苹果官方文档明确写了「不像 cron 会跳过，launchd 会在下次唤醒时启动任务」）。整天没开电脑就跳过当天。

手动触发一次：

```bash
launchctl start com.daily-brief
```

### 想发到手机上看

生成的 HTML 是**单文件、无外部依赖**（样式和交互全部内嵌），隔空投送到 iPhone、发微信、发邮件都能直接打开。

---

## 想改什么改哪里

| 想做的事 | 改哪里 |
|---|---|
| 加/关一个信源 | [`sources.config.json`](sources.config.json)，改 `enabled` 或加一条 |
| **调整板块的划分标准** | [`lib/ai/classify.ts`](lib/ai/classify.ts) 里的 `SYSTEM_PROMPT`，五个板块的定义都在那 |
| **调整简报的选条标准** | [`lib/ai/prompts.ts`](lib/ai/prompts.ts)，「挑选简报条目的标准」那一节 |
| 每条摘要的写法 | [`lib/ai/enrich.ts`](lib/ai/enrich.ts) |
| 每个板块显示多少条 | [`lib/output/render.ts`](lib/output/render.ts) 的 `MERGED_SUBGROUP_LIMITS` |
| 板块名称和顺序 | [`lib/output/render.ts`](lib/output/render.ts) 顶部的 `TEXTS_ZH` 和 `CATEGORY_ORDER` |
| 环境指标的标的 | [`lib/trading/watchlist.ts`](lib/trading/watchlist.ts) |
| 触发时间 | 重跑 `node scripts/install.mjs --at 07:30 --global` |

改完直接下次运行生效，不需要编译。

---

## 已知的脆弱点

- **36氪走的是 RSSHub 公共镜像**。36氪官方 RSS 已下线，没有别的路子（官方 API 返回的是网页外壳）。镜像会被上游间歇性封锁——实测同一个地址上午能用、下午 503。已配 **4 个镜像自动切换**，抓不到会依次重试；4 个全挂时当天该源为空，不影响其他源。
- **公众号内容拿不到**。微信生态封闭，`wechat2rss`、RSSHub 微信路由、`werss` 全部实测失败。机器之心、新智元目前只有公众号，暂时缺失。量子位有官网 RSS，已收录。
- **一级市场结构化数据拿不到**。IT桔子、烯牛数据、投中网都是付费数据库，公开接口全部拒绝访问。清科/投中的月度报告只能等媒体报道后由 AI 识别出来。
- **国家统计局的时间格式不标准**，可能解析不出发布时间，导致排序靠后。内容仍会进报告。
- **中文源不生成 AI 摘要**，直接显示原文摘录（省调用，中文原文本来就能读）。想让中文源也过一遍 AI，删掉 `sources.config.json` 里对应条目的 `"lang": "zh"`。

---

## 拉取上游更新

```bash
git fetch upstream && git merge upstream/main
```

改动较大的文件：`sources.config.json`、`lib/output/render.ts`、`lib/ai/prompts.ts`、`lib/ai/enrich.ts`、`lib/ai/classify.ts`（新增）、`lib/sources/types.ts`、`scripts/daily.ts`、`lib/trading/watchlist.ts`。合并时可能冲突。

上游原始文档保留在 [UPSTREAM-README.md](UPSTREAM-README.md)，二次开发指南在 [FORKING.md](FORKING.md)。
