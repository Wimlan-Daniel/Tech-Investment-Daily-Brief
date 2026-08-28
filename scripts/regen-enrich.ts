import "./_env";

import fs from "node:fs";
import path from "node:path";

import { enrichFinanceNewsSummaries } from "../lib/ai/enrich";
import { validateBackendCredentials } from "../lib/ai/llm";
import type { ArticleInput } from "../lib/ai/pipeline";
import { sources, REPORT_LOCALE } from "../lib/sources/registry";
import { ALL_CATEGORIES, type Category } from "../lib/sources/types";
import {
  MERGED_SUBGROUP_LIMITS,
  isSportsArticle,
} from "../lib/output/render";
import { todayKey } from "../lib/utils";

const OUTPUT_DIR = "daily_reports";

/**
 * Top up missing summary fields on the sidecar without re-running the
 * full daily pipeline. Useful when MERGED_SUBGROUP_LIMITS bumps up
 * (e.g. politics 10 → 15) and the previous enrichment only covered
 * the old top-N. Honors REPORT_LOCALE: sources already in the target
 * language are skipped just like in daily.ts.
 *
 * Usage:
 *   npm run regen-enrich -- politics:world
 *   npm run regen-enrich -- finance:news 2026-05-15
 *
 * Follow up with `npm run render` to refresh HTML.
 */
async function main() {
  validateBackendCredentials();

  // 本 fork 每个板块只有一个合并列表，所以参数直接就是板块名，不再有 :subcategory
  const category = (process.argv[2] ?? "") as Category;
  const date = process.argv[3] || todayKey();
  if (!ALL_CATEGORIES.includes(category)) {
    throw new Error(
      `用法: tsx scripts/regen-enrich.ts <板块> [日期]\n可选板块: ${ALL_CATEGORIES.join(" | ")}`,
    );
  }

  const sidecarPath = path.join(OUTPUT_DIR, date, `${date}-articles.json`);
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`Sidecar not found: ${sidecarPath}`);
  }
  const data = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as {
    date: string;
    articles: ArticleInput[];
  };

  // 与 scripts/daily.ts 的 enrichCategory 保持一致：按【文章的板块】筛选，
  // 而不是按信源配置里的 category——后者在分类之后已经失效。
  const enabledIds = new Set(
    sources.filter((s) => s.enabled !== false).map((s) => s.id),
  );
  const sameLocaleIds = new Set(
    sources.filter((s) => (s.lang ?? "en") === REPORT_LOCALE).map((s) => s.id),
  );
  const limit = MERGED_SUBGROUP_LIMITS[`${category}:main`] ?? 12;
  const top = data.articles
    .filter((a) => a.category === category && enabledIds.has(a.sourceId))
    .filter((a) => !isSportsArticle(a.title))
    .sort((a, b) => {
      const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, limit);

  const missing = top
    .filter((a) => !sameLocaleIds.has(a.sourceId))
    .filter((a) => !a.summary && !(a as { cnSummary?: string }).cnSummary);
  console.log(
    `[regen-enrich] ${category}：展示 ${top.length} 条，其中 ${missing.length} 条缺摘要`,
  );
  if (missing.length === 0) {
    console.log("[regen-enrich] nothing to do.");
    return;
  }

  const t0 = Date.now();
  const summaries = await enrichFinanceNewsSummaries(missing);
  console.log(
    `[regen-enrich] enrichment done in ${((Date.now() - t0) / 1000).toFixed(1)}s, matched ${summaries.size}/${missing.length}`,
  );

  let patched = 0;
  for (const a of data.articles) {
    const s = summaries.get(a.url);
    if (s && !a.summary && !(a as { cnSummary?: string }).cnSummary) {
      a.summary = s.summary;
      if (s.titleZh) a.title = s.titleZh;
      patched++;
    }
  }
  fs.writeFileSync(sidecarPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[regen-enrich] patched ${patched} articles in ${sidecarPath}`);
  console.log(`[regen-enrich] now run \`npm run render\` to refresh HTML.`);
}

main().catch((e) => {
  console.error("[regen-enrich] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
