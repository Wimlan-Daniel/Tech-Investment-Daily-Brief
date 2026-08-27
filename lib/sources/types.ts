/**
 * 报告的五个板块。这里的取值同时是 sources.config.json 里 category 字段的合法值。
 *
 * 重要：源配置里写的 category 只是**兜底猜测**，真正的归类由 lib/ai/classify.ts
 * 在抓取之后逐条判断并覆写。原因是同一个源里内容性质差异极大——36氪快讯里既有
 * 一级市场融资，也有 A 股财报快讯，按来源分板块分不开。
 */
export type Category =
  | "frontier-tech" // 前沿技术：技术本身的进展，论文、能力突破、路线之争
  | "tech-business" // 科技商业：前沿科技的泛商业进展，发布、产品、客户、产能、公司动作
  | "china-vc" // 中国一级市场：融资、基金、退出、政策，兼顾美国等海外关键信息
  | "capital-markets" // 资本市场：中国及全球股市
  | "global-business"; // 全球商业：按金融时报头版标准筛选的重大商业事件

export const ALL_CATEGORIES: Category[] = [
  "frontier-tech",
  "tech-business",
  "china-vc",
  "capital-markets",
  "global-business",
];
export type SourceType = "rss" | "api" | "scrape";

export interface SourceDef {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  category: Category;
  /**
   * 备用地址。主 url 抓不到内容时按顺序依次重试，任一成功即采用。
   *
   * 加这个是因为 36氪官方 RSS 已下线、只能走 RSSHub 公共镜像，而这些镜像
   * 会被上游间歇性封锁——实测同一个地址上午能用、下午就 503。单地址等于
   * 把最重要的信源押在别人的运维上。
   */
  fallbackUrls?: string[];
  /**
   * 信源层级，用于在页面上标注可信度：
   *   "first"  —— 第一手：官方博客、官方公告、监管机构、原始论文
   *   "media"  —— 二手：媒体报道、转述、聚合
   * 缺省视为 "media"。
   */
  tier?: "first" | "media";
  /**
   * Group key within a category. Render order/labels are defined per
   * category in lib/output/render.ts. Categories without a registered
   * order render flat (no L2 tabs).
   */
  subcategory?: string;
  /**
   * When true, the rss fetcher shells out to curl instead of using
   * Node's undici. Required for hosts that TLS-fingerprint Node
   * (Cloudflare's "Just a moment…" challenge — LinuxDo, Reddit, etc.)
   */
  useCurl?: boolean;
  enabled?: boolean;
  /**
   * Source content language. Default treated as "en". When this equals
   * the active REPORT_LOCALE, the summary-enrichment step skips this
   * source — its content is already in the target language, so an LLM
   * "summary" would just be a slightly-shorter rewrite.
   */
  lang?: "zh" | "en";
  /**
   * Report locales this source participates in. Defaults to ["zh", "en"]
   * (both) when omitted. Set to ["zh"] for Chinese-only sources whose
   * content is meaningless to English-mode readers (V2EX/LinuxDo/etc.),
   * or ["en"] for English-community sources used to replace Chinese ones
   * when REPORT_LOCALE=en. The registry filters by REPORT_LOCALE at load.
   */
  locales?: ("zh" | "en")[];
  /**
   * Optional human-readable note explaining why a source is disabled or
   * any context useful for fork users. Ignored at runtime.
   */
  notes?: string;
  /**
   * Optional keyword filter list. When present, only items whose title or
   * body matches at least one keyword (case-insensitive) are kept.
   * Omit or leave empty to return all items unfiltered.
   */
  keywords?: string[];
}

export interface RawArticle {
  sourceId: string;
  title: string;
  url: string;
  excerpt?: string;
  publishedAt?: Date;
  /**
   * 抓取时来自源配置的兜底值；classify.ts 会在抓取后按内容覆写成真实板块。
   */
  category: Category;
  /**
   * LLM-generated summary in the active REPORT_LOCALE language. For zh
   * reports this is the Chinese translation/summary of an English source;
   * for en reports it'd be the English summary of a non-English source.
   */
  summary?: string;
  /**
   * Structured one-line metadata to display above the excerpt — currently
   * used by GitHub Trending for "Language · ★stars · forks · stars today".
   */
  meta?: string;
}
