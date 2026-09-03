import "./_env";

import fs from "node:fs";
import path from "node:path";

import {
  generateDailyReport,
  type ArticleInput,
  type DailyReport,
} from "../lib/ai/pipeline";
import { getModelTag, validateBackendCredentials } from "../lib/ai/llm";
import { loadPreviousBriefTitles, RECENT_DAYS } from "../lib/brief-history";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

/**
 * 只重跑「每日简报」这一栏，其余原样保留。
 *
 * 关键点：**不重新抓取**，用当天已存下的 <date>-articles.json。所以重跑
 * 出来的内容仍然是当初那一次抓取的快照——不会混进当天早上抓取之后才发布
 * 的新闻。这既省掉 20 分钟的抓取和 20 次摘要调用，也保证「8 点的简报」
 * 仍然只包含 8 点前的消息，不会去抢明天该报的事件。
 *
 * 什么时候用：
 *   · 判重规则或简报提示词改了，想让今天这份跟上
 *   · 简报那次调用输出跑偏（漏板块、格式错），但摘要和行情都是好的
 *
 * 成本：1 次调用（简报用的是 Opus），约 2-3 分钟。
 *
 * 用法：
 *   npm run regen-digest              # 今天
 *   npm run regen-digest -- 2026-09-03
 *
 * 跑完接 `npm run render <date>` 刷新网页，再按需 `npm run publish`。
 */
function loadArticles(date: string): ArticleInput[] {
  const file = path.join(OUTPUT_DIR, date, `${date}-articles.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`找不到当天的资讯缓存: ${file}——先跑 npm run daily`);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
    articles: Array<
      Omit<ArticleInput, "publishedAt"> & { publishedAt?: string }
    >;
  };
  return data.articles.map((a) => ({
    ...a,
    publishedAt: a.publishedAt ? new Date(a.publishedAt) : undefined,
  }));
}

async function main() {
  validateBackendCredentials();

  const date = process.argv[2] || todayKey();
  const jsonPath = path.join(OUTPUT_DIR, date, `${date}.json`);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`找不到报告: ${jsonPath}`);
  }
  const old = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as DailyReport;
  const articles = loadArticles(date);

  const newest = articles
    .map((a) => a.publishedAt?.getTime() ?? 0)
    .reduce((m, t) => Math.max(m, t), 0);
  console.log(
    `[regen-digest] ${date} — 用缓存的 ${articles.length} 条资讯，不重新抓取` +
      (newest ? `（最新一条发布于 ${new Date(newest).toISOString()}）` : ""),
  );

  const previousTitles = loadPreviousBriefTitles(date, OUTPUT_DIR);
  console.log(
    `[regen-digest] 判重清单：近 ${RECENT_DAYS} 天已报 ${previousTitles.length} 条`,
  );

  console.log(`[regen-digest] 用 ${getModelTag()} 重跑简报…`);
  const t0 = Date.now();
  const { report } = await generateDailyReport(articles, previousTitles);
  console.log(
    `[regen-digest] 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );

  if (!report.top_briefs?.length) {
    // 空简报多半是登录过期或限流。写进去等于把好报告换成坏报告。
    throw new Error("重跑结果为空——原报告保持不动，请检查登录状态后重试");
  }

  // 换掉整段文字内容——大标题、导语、编辑短评、关键词都是围绕头条写的，
  // 只换 top_briefs 会让导语还在讲一条已经被判重拿掉的新闻。
  // 唯独 trading 沿用原报告：行情是抓取那一刻的快照，重新取会变成现在的
  // 盘中数据，那会让「8 点的简报」名不副实。
  const merged: DailyReport = {
    ...report,
    ...(old.trading ? { trading: old.trading } : {}),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2), "utf8");

  // 比对不能用字符串相等：每次重跑模型都会把标题重新润色一遍，
  // 同一件事的两次写法几乎不会一模一样，那样会把整页都标成「新」。
  // 用二元组 Jaccard 相似度做近似匹配。阈值 0.18 是在 2026-09-03 的
  // 真实前后两版上量出来的：同一事件的两种写法落在 0.24-0.77，
  // 确实不同的事件落在 0.03-0.09，中间有一段很宽的空隙。
  const bigrams = (t: string) => {
    const c = t.replace(/[\s　]+/g, "").toLowerCase();
    return new Set(
      Array.from({ length: Math.max(c.length - 1, 0) }, (_, i) =>
        c.slice(i, i + 2),
      ),
    );
  };
  const sameEvent = (a: string, b: string) => {
    const x = bigrams(a);
    const y = bigrams(b);
    if (!x.size || !y.size) return false;
    let hit = 0;
    for (const g of x) if (y.has(g)) hit++;
    return hit / (x.size + y.size - hit) >= 0.18;
  };
  const oldBriefs = old.top_briefs ?? [];
  console.log("\n[regen-digest] 新的头条：");
  for (const b of merged.top_briefs) {
    const was = oldBriefs.some((o) => sameEvent(o.title, b.title));
    console.log(`  ${b.importance}  ${b.title}${was ? "" : "   ← 新增"}`);
  }
  const dropped = oldBriefs.filter(
    (o) => !merged.top_briefs.some((n) => sameEvent(o.title, n.title)),
  );
  if (dropped.length) {
    console.log("\n[regen-digest] 被换掉的：");
    for (const b of dropped) console.log(`  ${b.importance}  ${b.title}`);
  }
  console.log(`\n[regen-digest] 已写入 ${jsonPath}`);
  console.log(`[regen-digest] 接着跑：npm run render ${date}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
