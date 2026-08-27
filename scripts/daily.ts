import "./_env";

import fs from "node:fs";
import path from "node:path";

import { sources, REPORT_LOCALE } from "../lib/sources/registry";
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

async function fetchAll(): Promise<ArticleInput[]> {
  const articles: ArticleInput[] = [];
  const enabled = sources.filter((s) => s.enabled !== false);
  for (const source of enabled) {
    try {
      const items = await fetchSource(source);
      console.log(`  ${source.id.padEnd(20)} ${items.length}`);
      articles.push(...items.map((it) => ({ ...it, source: source.name })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`  ${source.id.padEnd(20)} FAILED — ${msg}`);
    }
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
    if (s) a.summary = s;
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
    if (s) a.summary = s;
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
    if (s) a.summary = s;
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
  const sameLocaleIds = new Set(
    sources
      .filter((s) => (s.lang ?? "en") === REPORT_LOCALE)
      .map((s) => s.id),
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
  const toEnrich = top.filter((a) => !sameLocaleIds.has(a.sourceId));
  if (toEnrich.length === 0) {
    console.log(`[daily] ${category}：${top.length} 条展示，均为中文源，跳过摘要`);
    return;
  }
  console.log(
    `[daily] ${category}：为 ${toEnrich.length}/${top.length} 条生成中文摘要…`,
  );
  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(toEnrich);
  for (const a of toEnrich) {
    const s = summaries.get(a.url);
    if (s) a.summary = s;
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
async function runTrading(): Promise<TradingSection | null> {
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
    trading = await runTrading();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[daily] trading section failed: ${msg}`);
  }

  console.log(`[daily] generating digest with ${getModelTag()}…`);
  const t0 = Date.now();
  const { report } = await generateDailyReport(articles);
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
  fs.writeFileSync(`${base}.html`, renderHtml(report, raw, date), "utf8");
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
