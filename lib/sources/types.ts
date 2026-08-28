import type { BoardId } from "../../boards.config";
import { BOARD_IDS } from "../../boards.config";

/**
 * 板块类型。**取值由 boards.config.ts 定义**，想增删板块改那个文件即可，
 * 这里会自动跟着变。
 *
 * 注意：源配置里写的 category 只是**兜底猜测**，真正的归类由
 * lib/ai/classify.ts 在抓取之后逐条判断并覆写——同一个源里内容性质差异
 * 极大（36氪快讯里既有一级市场融资，也有 A 股财报快讯）。
 */
export type Category = BoardId;

export const ALL_CATEGORIES: Category[] = BOARD_IDS;

export type SourceType = "rss" | "api" | "scrape";

export interface SourceDef {
  id: string;
  name: string;
  type: SourceType;
  url: string;
  category: Category;
  /**
   * 时区纠偏（小时）。个别源的 RSS 把本地时间填进时间戳却标成 GMT——
   * 实测 InfoQ 中国：北京时间 12:51 发布的文章，feed 里写 "12:51 GMT"。
   * 按标准解析会快 8 小时，显示成未来时间，还会在按时间排序的列表里
   * 永远霸占最前。设 8 表示解析后减 8 小时。
   */
  tzFixHours?: number;
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
