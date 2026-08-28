import { jsonrepair } from "jsonrepair";
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import { SYSTEM_PROMPT_DIGEST_EN, SYSTEM_PROMPT_DIGEST_ZH } from "./prompts";
import { REPORT_LOCALE, sources } from "../sources/registry";
import type { Category, RawArticle } from "../sources/types";

const SYSTEM_PROMPT_DIGEST =
  REPORT_LOCALE === "en" ? SYSTEM_PROMPT_DIGEST_EN : SYSTEM_PROMPT_DIGEST_ZH;

/** sourceId → 信源层级。让简报里的每条都能标出是官方发布还是媒体报道。 */
const TIER_BY_SOURCE = new Map(sources.map((s) => [s.id, s.tier ?? "media"]));

export function sourceTier(sourceId: string): "first" | "media" {
  return TIER_BY_SOURCE.get(sourceId) ?? "media";
}

export interface BriefItem {
  title: string;
  url: string;
  source: string;
  summary: string;
  importance: number;
  /** 该条属于哪个板块——简报页上给每条打板块标签用 */
  category: Category;
  /** 旧版字段，已按用户要求停用；保留可选定义以兼容历史 JSON */
  why?: string;
  /** 信源层级，"first" 表示第一手（官方发布） */
  tier?: "first" | "media";
}

export interface DailyReport {
  hero_headline: string;
  daily_overview: string;
  /**
   * 每日简报：跨全部板块精选的当天最关键条目，渲染在首页第一个标签页。
   * 上游是按板块分成三个数组，本 fork 改成一个统一列表——读者要的是
   * "今天最重要的几件事"，而不是"每个板块各挑几条"。板块信息在每条的
   * category 字段上，页面按标签展示。
   */
  top_briefs: BriefItem[];
  editor_note: string;
  keywords: string[];
  /** Optional trading-signals section, present when scripts/daily.ts ran successfully. */
  trading?: TradingSection;
}

import type { TickerAnalysis } from "../trading/signals";
import type { CryptoGlobalStats } from "../trading/coingecko";
import type { FearGreedSnapshot } from "../trading/fear-greed";
import type { TradingCommentary } from "./trading-commentary";

export interface TradingSection extends TradingCommentary {
  generated_at: string;
  tickers: TickerAnalysis[];
  crypto_fear_greed?: FearGreedSnapshot;
  crypto_global?: CryptoGlobalStats;
}

export interface ArticleInput extends RawArticle {
  source: string;
}

/**
 * 送进简报生成的候选条数上限（按板块）。这是给 LLM 的输入量，不是页面展示量。
 * 一级市场是读者最关心的，给最多配额。
 */
const PER_CATEGORY_LIMIT: Record<Category, number> = {
  "china-vc": 30,
  "frontier-tech": 25,
  "tech-business": 25,
  "capital-markets": 15,
  "global-business": 15,
};

const MAX_AGE_DAYS = 14;

/**
 * Pick `limit` items from `items` so every source gets a fair shot.
 *
 * Why this exists: the previous `slice(0, limit)` honored insertion order,
 * which is the source-iteration order in daily.ts. That gave whichever
 * source came first 100% of the quota — e.g. all 25 tech slots filled by
 * Hacker News before GitHub Trending / Solidot / V2EX / 阮一峰 got a turn.
 *
 * Strategy: drop items older than MAX_AGE_DAYS, group by sourceId,
 * sort each bucket newest-first, then round-robin one item per source
 * until we hit the limit. Sources with fewer items naturally drop out
 * and others absorb the slack.
 */
function selectRoundRobin(
  items: ArticleInput[],
  limit: number,
): ArticleInput[] {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const fresh = items.filter(
    (it) => !it.publishedAt || it.publishedAt.getTime() >= cutoff,
  );

  const bySource = new Map<string, ArticleInput[]>();
  for (const it of fresh) {
    const arr = bySource.get(it.sourceId) ?? [];
    arr.push(it);
    bySource.set(it.sourceId, arr);
  }
  for (const arr of bySource.values()) {
    arr.sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    );
  }

  const buckets = Array.from(bySource.values());
  const out: ArticleInput[] = [];
  let madeProgress = true;
  while (out.length < limit && madeProgress) {
    madeProgress = false;
    for (const b of buckets) {
      if (b.length === 0) continue;
      out.push(b.shift()!);
      madeProgress = true;
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function callOnce(
  userPayloadJson: string,
  prevBlock: string,
): Promise<DailyReport> {
  // Claude Code CLI's built-in system prompt biases the model toward
  // conversational markdown output. Anchor the format expectation in the
  // user message (instruction recency wins) *and* explicitly demand every
  // schema field be populated — without this Sonnet has been observed to
  // emit a JSON shell with empty arrays to "satisfy" a JSON-only ask.
  const userPrompt =
    REPORT_LOCALE === "en"
      ? [
          "**Output language: ENGLISH ONLY.** Every string value in the JSON — hero_headline, daily_overview, every brief's title/summary, editor_note, keywords — must be written entirely in English. No Chinese characters anywhere.",
          "",
          "Your task: generate today's daily brief from the candidate news below. **The response MUST be a single valid JSON object** — starts with `{`, ends with `}`, no markdown, no code fences, no explanations.",
          "",
          "The JSON must contain every field non-empty:",
          "  - hero_headline: 10-25 word headline of the day",
          "  - daily_overview: **180-260 word** paragraph threading private markets / frontier tech / capital environment",
          "  - top_briefs: **6-8** BriefItems selected across all sections, ordered by importance",
          "  - editor_note: 40-70 word editor's note naming today's most notable signal",
          "  - keywords: 5-8 keywords, sectors and company names first",
          "",
          "BriefItem fields (all required): title (18-28 chars, information-dense: actor + action + amount + purpose/outcome — never a bare stub), url (verbatim from candidate), source, category (one of frontier-tech / tech-business / china-vc / capital-markets / global-business, copied from the candidate), tier (copied from the candidate), summary (60-110 words covering the 5W elements present in the source), importance (1-10, scored on the absolute scale in the system prompt, independent of section).",
          "**Quote rule (important!)**: For any quotation INSIDE a JSON string, use single quotes ' or curly quotes '\" — **never** raw double quotes \", which break JSON parsing.",
          "No trailing commas.",
          "",
          prevBlock,
          `Candidate news (JSON array, ${userPayloadJson.length} chars):`,
          userPayloadJson,
        ].join("\n")
      : [
          "你的任务：从下方候选资讯中，挑出**今天最值得这位一级市场前沿科技投资人知道的 6-8 条**，生成一份简报。**响应必须是一个合法 JSON 对象**——以 `{` 开头，以 `}` 结尾，不要 markdown / 不要代码围栏 / 不要任何解释。",
          "",
          "JSON 必须包含全部字段且不能为空：",
          "  - hero_headline: 10-25 字的当日一句话头条，点出今天最重要的那件事",
          "  - daily_overview: **180-260 字** 的当日总览，按「一级市场 / 前沿科技 / 资本环境」三条线索串起来，让读者 30 秒抓住全貌",
          "  - top_briefs: **6-8 条** BriefItem，跨板块精选，按重要性从高到低排列",
          "  - editor_note: 40-70 字的编辑短评，点出今天最值得注意的一个信号或趋势",
          "  - keywords: 5-8 个关键词，优先赛道名和公司名",
          "",
          "BriefItem 字段（全部必填）：",
          "  - title：改写后的中文标题，18-28 字。不标题党的前提下**塞进尽可能多的关键事实**（主体、动作、金额、目的或结果），宁可贴近字数上限，不要写成干瘪短句。好例：「Anthropic据悉450亿美元锁定AI算力备战IPO」（主体+金额+动作+目的俱全）；差例：「Anthropic据悉锁定450亿美元算力」（丢了目的，信息量骤减）",
          "  - url：必须从候选条目中原样复制，绝不编造",
          "  - source：候选条目的 source 字段原样回填",
          "  - category：该条的板块，必须是 frontier-tech / tech-business / china-vc / capital-markets / global-business 之一，原样沿用候选条目的 category",
          "  - tier：原样沿用候选条目的 tier（first 或 media）",
          "  - summary：60-110 字中文摘要，覆盖新闻五要素中原文给出的部分（谁 / 何时 / 何事 / 关键数据 / 影响对象），读者只看这段就能掌握重点",
          "  - importance：1-10 的整数，按 system prompt 里的重要度评分标准客观打分，与板块无关；平静日的最高分可以只有 6，不要抬分",
          "",
          "选条标准（按优先级）：",
          "  1. 中国一级市场的融资与退出事件，尤其前沿科技赛道",
          "  2. 改变技术判断的进展——能力拐点、路线收敛、成本结构变化",
          "  3. 头部公司的重大商业动作，可能改变竞争格局的",
          "  4. 直接影响募资或退出环境的政策与资本市场变化",
          "  5. 按《金融时报》头版标准值得知道的全球商业事件",
          "同一件事被多家报道时只保留一条，选信源层级更高的那条（tier=first 优先），summary 末尾标注「（多家报道）」。",
          "",
          "**引号规则（重要！）**：JSON 字符串内的中文引用请使用**中文全角引号**「」或者 “”，**绝对不要**用英文双引号 \" —— 那会导致 JSON 解析失败。例：写 商务部回应「内卷」 而不是 商务部回应\"内卷\"。",
          "不要使用单引号、不要末尾多余逗号。",
          "",
          prevBlock,
          "候选资讯（JSON 数组，共 " + userPayloadJson.length + " 字符）：",
          userPayloadJson,
        ].join("\n");
  const { text } = await runLlm({
    systemPrompt: SYSTEM_PROMPT_DIGEST,
    userPrompt,
    // 简报是全流程最大的一次调用（400+ 条候选 + 昨日清单），实测常规耗时
    // 120-300 秒。默认 180 秒超时线其实一直是靠外层 retry 才撑过去的，
    // 这里直接放宽，别再赌重试。
    timeoutMs: 480_000,
  });
  const cleaned = extractJson(text);
  let parsed: Partial<DailyReport>;
  try {
    parsed = JSON.parse(cleaned) as Partial<DailyReport>;
  } catch (strictErr) {
    // LLMs routinely emit JSON with unescaped quotes inside Chinese
    // strings (e.g. 商务部回应"内卷"). jsonrepair fixes most of these
    // mechanically before we ever surface a failure.
    try {
      const repaired = jsonrepair(cleaned);
      parsed = JSON.parse(repaired) as Partial<DailyReport>;
      console.warn("[pipeline] JSON.parse failed but jsonrepair recovered");
    } catch {
      try {
        const fs = await import("node:fs");
        fs.mkdirSync("logs", { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(`logs/claude-raw-${ts}.txt`, text, "utf8");
        fs.writeFileSync(`logs/claude-cleaned-${ts}.txt`, cleaned, "utf8");
        console.warn(
          `[pipeline] both JSON.parse and jsonrepair failed; raw at logs/claude-raw-${ts}.txt`,
        );
      } catch {
        // best-effort logging
      }
      throw strictErr;
    }
  }
  return {
    hero_headline: parsed.hero_headline ?? "",
    daily_overview: parsed.daily_overview ?? "",
    top_briefs: (parsed.top_briefs ?? []).filter(
      (b) => b && typeof b.url === "string" && b.url.length > 0,
    ),
    editor_note: parsed.editor_note ?? "",
    keywords: parsed.keywords ?? [],
  };
}

export async function generateDailyReport(
  articles: ArticleInput[],
  /**
   * 昨天简报已报过的事件标题。判重的唯一依据——模型对清单里的事件默认
   * 跳过（有实质新进展才重新入选），清单外的事件不因文章日期旧而降分。
   * 之前用「发布日期旧就减 2 分」判重，会误伤读者从没见过的消息，
   * 用户明确要求改为只和昨日简报比对。
   */
  previousBriefTitles: string[] = [],
): Promise<{ report: DailyReport; tokensUsed: number }> {
  const grouped: Record<Category, ArticleInput[]> = {
    "frontier-tech": [],
    "tech-business": [],
    "china-vc": [],
    "capital-markets": [],
    "global-business": [],
  };
  for (const a of articles) grouped[a.category].push(a);

  const compact = (Object.keys(grouped) as Category[]).flatMap((c) =>
    selectRoundRobin(grouped[c], PER_CATEGORY_LIMIT[c]),
  );

  const userPayload = compact.map((a, i) => ({
    n: i + 1,
    title: a.title,
    url: a.url,
    source: a.source,
    category: a.category,
    tier: sourceTier(a.sourceId),
    excerpt: (a.summary ?? a.excerpt ?? "").slice(0, 220),
    published: a.publishedAt?.toISOString() ?? "",
  }));
  const userPayloadJson = JSON.stringify(userPayload);

  const prevBlock =
    previousBriefTitles.length > 0
      ? (REPORT_LOCALE === "en"
          ? "Events already briefed YESTERDAY (dedup list — skip unless there is a substantive new development, and then state what is new):\n"
          : "昨日简报已报过的事件（判重清单——除非有实质新进展否则不要再选；重新入选必须写明新进展）：\n") +
        previousBriefTitles.map((t) => `  - ${t}`).join("\n") +
        "\n"
      : "";

  let report: DailyReport;
  try {
    report = await callOnce(userPayloadJson, prevBlock);
  } catch (firstErr) {
    // One retry — claude CLI occasionally wraps in narration on the first
    // pass but obeys when the same prompt is repeated.
    console.warn(
      `[pipeline] first claude CLI call failed, retrying: ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
    );
    report = await callOnce(userPayloadJson, prevBlock);
  }

  // Max subscription has no per-call token meter — we expose 0 for schema
  // compatibility; consumers should treat 0 as "metric not available".
  return { report, tokensUsed: 0 };
}
