/**
 * 第一财经（yicai.com）直抓。
 *
 * 老牌财经媒体，宏观政策、产业深度、A股解读都有，是资本市场与全球商业
 * 两个板块的主力补充。官方 RSS 已下线（/rss/ 返回 404）。
 *
 * 抓 /news/ 列表页而非首页：首页 1.1MB 里混着大量轮播、广告位和推荐模块，
 * /news/ 是纯资讯流，每条的标题、摘要、时间齐全，结构也稳定：
 *
 *   <a href="/news/103337083.html" class="f-db">
 *     <div class="m-list m-list-1 f-cb">
 *       <div class="lef …"><img …></div>
 *       <div class="common">
 *         <h2>财政部纵深推进财政科学管理，有何看点？</h2>
 *         <p>财政部做出新的五大部署</p>
 *         <div class="author">…<span>9分钟前</span></div>
 *
 * 时间字段是混合格式：当天用相对时间（「9分钟前」「3小时前」），更早的用
 * 「MM-DD HH:MM」。两种都解析，解析不出就留空——留空的条目仍会进流程，
 * 只是在时间排序里靠后。
 */
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PAGE_URL = "https://www.yicai.com/news/";
const BASE = "https://www.yicai.com";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 解析第一财经的混合时间格式。
 *
 * 相对时间以抓取时刻为基准回推——这在每天定时跑的场景下足够准。
 * 「MM-DD HH:MM」没有年份，按"不晚于今天"推断年份：月日晚于今天则算上一年
 * （跨年时 12-31 的条目不会被误判成未来时间）。
 */
interface YicaiTime {
  d: Date;
  /**
   * 精度只有小时级或天级（「3小时前」「2天前」这类相对表述换算出的时刻
   * 误差可达一小时以上）。用户要求时间要么准确要么只写日期，所以这类
   * 只在页面上显示日期。分钟级（「9分钟前」「刚刚」「MM-DD HH:MM」）视为准确。
   */
  dateOnly: boolean;
}

function parseYicaiTime(raw: string, now: Date): YicaiTime | undefined {
  const s = raw.trim();

  const min = s.match(/^(\d+)\s*分钟前/);
  if (min)
    return { d: new Date(now.getTime() - Number(min[1]) * 60_000), dateOnly: false };

  const hr = s.match(/^(\d+)\s*小时前/);
  if (hr)
    return { d: new Date(now.getTime() - Number(hr[1]) * 3_600_000), dateOnly: true };

  if (/^刚刚/.test(s)) return { d: new Date(now.getTime()), dateOnly: false };

  const day = s.match(/^(\d+)\s*天前/);
  if (day)
    return { d: new Date(now.getTime() - Number(day[1]) * 86_400_000), dateOnly: true };

  const md = s.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (md) {
    const [, mo, d, h, mi] = md;
    let year = now.getFullYear();
    const candidate = new Date(
      `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:00+08:00`,
    );
    if (Number.isNaN(candidate.getTime())) return undefined;
    // 解析出来比现在晚，说明是去年的条目
    if (candidate.getTime() > now.getTime() + 86_400_000) {
      year -= 1;
      const prev = new Date(
        `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${mi}:00+08:00`,
      );
      return Number.isNaN(prev.getTime())
        ? undefined
        : { d: prev, dateOnly: false };
    }
    return { d: candidate, dateOnly: false };
  }

  return undefined;
}

export async function fetchYicai(
  sourceId: string,
  category: Category,
  limit = 30,
): Promise<RawArticle[]> {
  const html = await curlFetch(PAGE_URL, HEADERS, 30);
  const now = new Date();

  const blockRe =
    /<a[^>]+href="(\/news\/\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set<string>();
  const out: RawArticle[] = [];

  for (const m of html.matchAll(blockRe)) {
    const href = m[1];
    if (seen.has(href)) continue;
    const inner = m[2];

    const h2 = inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const title = decode(h2[1].replace(/<[^>]+>/g, ""));
    if (!title) continue;

    const p = inner.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const excerpt = p ? decode(p[1].replace(/<[^>]+>/g, "")) : "";

    const sp = inner.match(
      /<div class="rightspan">\s*<span>([^<]*)<\/span>/,
    );
    const t = sp ? parseYicaiTime(decode(sp[1]), now) : undefined;

    seen.add(href);
    out.push({
      sourceId,
      title,
      url: BASE + href,
      excerpt: excerpt.slice(0, 800),
      publishedAt: t?.d,
      dateOnly: t?.dateOnly || undefined,
      category,
    });
    if (out.length >= limit) break;
  }

  if (out.length === 0) {
    throw new Error(
      "第一财经列表页没解析出条目 —— 结构可能改了，需要更新 lib/sources/yicai.ts",
    );
  }
  return out;
}
