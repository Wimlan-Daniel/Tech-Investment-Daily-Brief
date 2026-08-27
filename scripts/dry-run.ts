import "./_env";

import { sources } from "../lib/sources/registry";
import { fetchSource } from "../lib/sources/dispatch";
import type { ArticleInput } from "../lib/ai/pipeline";

// Source-fetch sanity check only — does NOT call the LLM. For the full
// ingest → digest → write-to-disk pipeline use `npm run daily` instead.
async function main() {
  console.log("Fetching from sources…\n");
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

  console.log(`\nTotal articles: ${articles.length}`);
  console.log("\nTop 10 articles:");
  articles.slice(0, 10).forEach((a, i) => {
    console.log(`  ${i + 1}. [${a.category}] ${a.title}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
