import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import type { SourceDef } from "../lib/sources/types";
import { fetchSource } from "../lib/sources/dispatch";
import {
  generateDailyReport,
  type ArticleInput,
} from "../lib/ai/pipeline";
import { getModelTag, validateBackendCredentials } from "../lib/ai/llm";
import { classifyArticles } from "../lib/ai/classify";
import { ALL_CATEGORIES, type Category } from "../lib/sources/types";
import {
  enrichFinanceNewsSummaries,
  enrichGithubTrendingSummaries,
  enrichTrendingPapersSummaries,
  enrichXViralSummaries,
} from "../lib/ai/enrich";
import {
  groupRaw,
  isSportsArticle,
  MERGED_SUBGROUP_LIMITS,
  renderHtml,
  renderMarkdown,
} from "../lib/output/render";
import { analyzeWatchlist } from "../lib/trading/runner";
import { fetchCryptoFearGreed } from "../lib/trading/fear-greed";
import { fetchCryptoGlobal } from "../lib/trading/coingecko";
import { generateTradingCommentary } from "../lib/ai/trading-commentary";
import type { TradingSection } from "../lib/ai/pipeline";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

/**
 * 找最近一期简报的条目标题，作为今天的判重清单。
 *
 * 判重只和「读者实际看过的简报」比对，不看文章发布日期——按日期打折会误伤
 * 从没上过榜的消息（读者没见过，对他就是新的）。取最近一期而不是严格的昨天：
 * 周末停跑或某天失败时，跳过的那几天不该让判重失效。
 */
function loadPreviousBriefTitles(todayDate: string): string[] {
  try {
    const dirs = fs
      .readdirSync(OUTPUT_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayDate)
      .sort()
      .reverse();
    for (const d of dirs) {
      const f = path.join(OUTPUT_DIR, d, `${d}.json`);
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, "utf8")) as {
        top_briefs?: { title?: string }[];
      };
      const titles = (j.top_briefs ?? [])
        .map((b) => b?.title)
        .filter((t): t is string => Boolean(t));
      if (titles.length > 0) return titles;
    }
  } catch {
    // 判重清单拿不到不该阻断整个流程——没有清单时模型按全新消息处理
  }
  return [];
}

/**
 * 人看的归档目录。
 *
 * daily_reports/ 里除了网页还有两个 JSON 边车文件（报告结构 + 全部抓取条目），
 * 那是给 scripts/render.ts 和 regen-* 工具复用数据的，人不需要看。所以每天
 * 额外把网页复制一份到这里，用「日期 + 名称」命名，按文件名排序就是按日期排序，
 * 双击即可打开，也方便直接发给别人。
 */
const ARCHIVE_DIR = "每日资讯留档";
const ARCHIVE_TITLE = "前沿科技投资简报";

async function fetchAll(): Promise<ArticleInput[]> {
  const articles: ArticleInput[] = [];
  const enabled = sources.filter((s) => s.enabled !== false);
  const failed: SourceDef[] = [];

  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
      failed.push(source);
    }
  }

  // 网络中断会造成大面积连续失败（2026-08-31 实测：机器跑到一半回睡，
  // 后 27 个源无一幸免）。等 30 秒让网络恢复后整轮补抓一次——失败面越大
  // 越说明是环境问题而非源本身挂了，这一轮补救的收益也就越高。
  if (failed.length > 0) {
    const ratio = failed.length / enabled.length;
    console.log(
      `\n[daily] ${failed.length}/${enabled.length} 个源失败${ratio > 0.3 ? "（失败面过大，疑似网络中断）" : ""}，30 秒后重试…`,
    );
    await new Promise((r) => setTimeout(r, 30_000));
    let recovered = 0;
    for (const source of failed) {
      try {
        const items = await fetchSource(source);
        console.log(`  ${source.id.padEnd(20)} ${items.length}  (重试成功)`);
        articles.push(...items.map((it) => ({ ...it, source: source.name })));
        recovered++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ${source.id.padEnd(20)} 重试仍失败 — ${msg}`);
      }
    }
    console.log(`[daily] 重试补回 ${recovered}/${failed.length} 个源\n`);
  }

  return articles;
}

async function enrichGhTrending(articles: ArticleInput[]): Promise<void> {
  const gh = articles.filter((a) => a.sourceId === "github-trending");
  if (gh.length === 0) return;
  console.log(
    `[daily] enriching ${gh.length} GitHub Trending repos with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichGithubTrendingSummaries(gh);
  for (const a of gh) {
    const s = summaries.get(a.url);
    if (s) {
      a.summary = s.summary;
      // 英文条目会带翻译好的中文标题；中文条目该字段为空
      if (s.titleZh) a.title = s.titleZh;
    }
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${gh.length}`,
  );
}

/**
 * X 热帖 enrichment is different from merged subgroups — we preserve the
 * AttentionVC API's heat-rank order (do NOT sort by date) and cap to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:x-viral"]).
 *
 * The Sonnet prompt also differs (XVIRAL_SYSTEM_PROMPT in enrich.ts) — X
 * tweet titles are clickbait, the previewText holds the actual claim.
 */
async function enrichXViral(articles: ArticleInput[]): Promise<void> {
  const xPosts = articles
    .filter((a) => a.sourceId === "attentionvc-ai")
    .slice(0, 20);
  if (xPosts.length === 0) return;
  console.log(`[daily] enriching ${xPosts.length} X posts with ${REPORT_LOCALE} summaries…`);
  const t0 = Date.now();
  // Author handle is encoded in the URL (https://x.com/{handle}/status/{id})
  // — extract it to help the model identify whose claim it is.
  const summaries = await enrichXViralSummaries(
    xPosts.map((a) => ({
      url: a.url,
      title: a.title,
      excerpt: a.excerpt,
      author: a.url.match(/x\.com\/([^/]+)\//)?.[1] ?? "",
    })),
  );
  for (const a of xPosts) {
    const s = summaries.get(a.url);
    if (s) {
      a.summary = s.summary;
      // 英文条目会带翻译好的中文标题；中文条目该字段为空
      if (s.titleZh) a.title = s.titleZh;
    }
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${xPosts.length}`,
  );
}

/**
 * Trending papers enrichment — preserves the fetcher's upvote-desc order
 * (huggingface-papers is in PRESERVE_FETCH_ORDER_SOURCES) and caps to the
 * displayed limit (matches SOURCE_DISPLAY_LIMITS["tech:trending-papers"]).
 */
async function enrichTrendingPapers(articles: ArticleInput[]): Promise<void> {
  const papers = articles
    .filter((a) => a.sourceId === "huggingface-papers")
    .slice(0, 20);
  if (papers.length === 0) return;
  console.log(
    `[daily] enriching ${papers.length} trending papers with ${REPORT_LOCALE} summaries…`,
  );
  const t0 = Date.now();
  const summaries = await enrichTrendingPapersSummaries(
    papers.map((a) => ({ url: a.url, title: a.title, excerpt: a.excerpt })),
  );
  for (const a of papers) {
    const s = summaries.get(a.url);
    if (s) {
      a.summary = s.summary;
      // 英文条目会带翻译好的中文标题；中文条目该字段为空
      if (s.titleZh) a.title = s.titleZh;
    }
  }
  console.log(
    `[daily] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${papers.length}`,
  );
}

/**
 * 板块合并列表的逐条摘要。
 *
 * 与上游的关键差异：上游按「信源的 category」筛选文章，本 fork 必须按
 * 「文章自己的 category」筛选——因为 lib/ai/classify.ts 会在抓取后逐条改写
 * article.category，此时源配置里的 category 已经只是个失效的兜底值了。
 * 如果沿用上游写法，分类之后两边对不上，摘要会大面积落空且不报错。
 *
 * 取数逻辑与 render.ts 的 groupRaw 保持对称：同板块全部文章按时间倒序，
 * 截到 MERGED_SUBGROUP_LIMITS 规定的展示条数，只对这些条目花钱做摘要。
 *
 * 已经是目标语言的源（lang === REPORT_LOCALE）跳过——中文源不需要再"翻译"
 * 成中文，省下这部分调用。
 */
async function enrichCategory(
  articles: ArticleInput[],
  category: Category,
): Promise<void> {
  const enabledIds = new Set(
    sources.filter((s) => s.enabled !== false).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:main`] ?? 12;
  const top = articles
    .filter((a) => a.category === category && enabledIds.has(a.sourceId))
    .filter((a) => !isSportsArticle(a.title))
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, limit);
  // 中文源同样要过 AI——它们的 excerpt 只是原文开头截取，不是摘要，直接展示
  // 会显得敷衍（用户原话）。真正跳过的只有两类：
  //   1. 已有摘要的（GitHub Trending / 论文在前面的专用流程里处理过）
  //   2. X 热帖（attentionvc-ai，主流程之后有保留热度排序的专用流程）
  const toEnrich = top.filter(
    (a) => !a.summary && a.sourceId !== "attentionvc-ai",
  );
  if (toEnrich.length === 0) {
    console.log(`[daily] ${category}：${top.length} 条展示，均已有摘要，跳过`);
    return;
  }
  console.log(
    `[daily] ${category}：为 ${toEnrich.length}/${top.length} 条生成中文摘要…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) {
      a.summary = s.summary;
      // 英文条目会带翻译好的中文标题；中文条目该字段为空
      if (s.titleZh) a.title = s.titleZh;
    }
  }
  console.log(
    `[daily] ${category}：摘要完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，命中 ${summaries.size}/${toEnrich.length}`,
  );
}

/**
 * Pull daily OHLCV from Yahoo for every ticker in the watchlist, compute
 * indicators + signals, then ask Sonnet for a market overview + a
 * picks-to-watch list. Returns null if no ticker came back.
 */
async function runTrading(
  articles: ArticleInput[],
): Promise<TradingSection | null> {
  console.log(`[daily] analyzing watchlist + crypto context (Yahoo / alt.me / CoinGecko)…`);
  const t0 = Date.now();
  const [tickers, cryptoFearGreed, cryptoGlobal] = await Promise.all([
    analyzeWatchlist(),
    fetchCryptoFearGreed(),
    fetchCryptoGlobal(),
  ]);
  console.log(
    `[daily] indicators ready in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${tickers.length} tickers` +
      (cryptoFearGreed ? `, F&G ${cryptoFearGreed.value}` : ", F&G ✗") +
      (cryptoGlobal
        ? `, BTC dom ${cryptoGlobal.btcDominance.toFixed(1)}%`
        : ", CG ✗"),
  );
  if (tickers.length === 0) return null;
  console.log(`[daily] generating trading commentary with ${getModelTag()}…`);
  const t1 = Date.now();
  const commentary = await generateTradingCommentary({
    tickers,
    cryptoFearGreed: cryptoFearGreed ?? undefined,
    cryptoGlobal: cryptoGlobal ?? undefined,
    // 技术指标回答不了"为什么涨/跌"。把当天分到科技商业与资本市场的新闻
    // 一并送过去，模型才有可能把英伟达这类标的的涨跌和具体事件对上。
    newsHeadlines: articles
      .filter(
        (a) =>
          a.category === "tech-business" || a.category === "capital-markets",
      )
      .sort(
        (a, b) =>
          (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
      )
      .slice(0, 60)
      .map((a) => ({
        title: a.title,
        summary: (a.summary ?? a.excerpt ?? "").slice(0, 120) || undefined,
      })),
  });
  console.log(
    `[daily] trading commentary ready in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
  );
  return {
    ...commentary,
    tickers,
    crypto_fear_greed: cryptoFearGreed ?? undefined,
    crypto_global: cryptoGlobal ?? undefined,
    generated_at: new Date().toISOString(),
  };
}

/** 只把这个天数窗口内的条目送去分类与展示。 */
const RECENT_DAYS = 7;

async function main() {
  // Fail fast on misconfigured backend before we spend 30s fetching
  // 500+ articles only to discover the LLM has no credentials.
  validateBackendCredentials();

  const date = todayKey();
  console.log(`[daily] ${date} — fetching sources…\n`);
  const fetched = await fetchAll();
  console.log(`\n[daily] total articles: ${fetched.length}`);
  if (fetched.length === 0) {
    throw new Error("no articles fetched — aborting");
  }

  // 只保留近期条目再送去分类：像 OpenAI 官方博客这种源，RSS 里混着几年前的
  // 存档，分类它们既费调用又没意义。没有发布时间的条目一律保留（宁可多留）。
  const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const recent = fetched.filter(
    (a) => !a.publishedAt || a.publishedAt.getTime() >= cutoff,
  );
  if (recent.length < fetched.length) {
    console.log(
      `[daily] 按 ${RECENT_DAYS} 天窗口过滤：${fetched.length} → ${recent.length} 条`,
    );
  }

  // 逐条分类：这是本 fork 的核心步骤，把内容按性质分进五个板块并剔除噪音。
  // 分类结果会覆写 article.category，下游全部依赖它。
  const articles = await classifyArticles(recent);
  if (articles.length === 0) {
    throw new Error("分类后没有剩余条目 — 中止");
  }

  // Enrich GH Trending, papers, finance news, and politics with summaries.
  await enrichGhTrending(articles);
  await enrichTrendingPapers(articles);
  for (const c of ALL_CATEGORIES) {
    await enrichCategory(articles, c);
  }
  await enrichXViral(articles);

  // Trading signals: Yahoo fetch + indicators + commentary. Non-fatal —
  // if it errors, we still ship the news digest.
  let trading: TradingSection | null = null;
  try {
    trading = await runTrading(articles);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] trading section failed: ${msg}`);
  }

  console.log(`[daily] generating digest with ${getModelTag()}…`);
  const t0 = Date.now();
  const previousTitles = loadPreviousBriefTitles(date);
  if (previousTitles.length > 0) {
    console.log(
      `[daily] 昨日已报清单：${previousTitles.length} 条，用于判重（重复事件除非有新进展否则不再选入）`,
    );
  }
  const { report } = await generateDailyReport(articles, previousTitles);
  if (trading) report.trading = trading;
  console.log(`[daily] digest ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const dateDir = path.join(OUTPUT_DIR, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const base = path.join(dateDir, date);
  const raw = groupRaw(articles, sources);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), "utf8");
  // Sidecar with all fetched articles + LLM-attached summary, so
  // scripts/render.ts can rebuild HTML/MD for UI iteration without
  // re-fetching or re-calling the LLM.
  fs.writeFileSync(
    `${base}-articles.json`,
    JSON.stringify({ date, articles }, null, 2),
    "utf8",
  );
  const html = renderHtml(report, raw, date);
  fs.writeFileSync(`${base}.html`, html, "utf8");

  // 归档一份给人看的：每日资讯留档/2026-08-27 前沿科技投资简报.html
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archivePath = path.join(
    ARCHIVE_DIR,
    `${date} ${ARCHIVE_TITLE}.html`,
  );
  fs.writeFileSync(archivePath, html, "utf8");
  console.log(`[daily] 已归档: ${archivePath}`);
  if (process.env.OUTPUT_MARKDOWN === "true") {
    fs.writeFileSync(`${base}.md`, renderMarkdown(report, date), "utf8");
    console.log(`[daily] wrote ${base}.{json,html,md,articles.json}`);
  } else {
    console.log(`[daily] wrote ${base}.{json,html,articles.json}`);
  }

  console.log(`[daily] done.`);
}

main().catch((e) => {
  console.error(`[daily] FAILED:`, e);
  process.exit(1);
});
