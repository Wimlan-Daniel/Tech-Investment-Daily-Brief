import Parser from "rss-parser";
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
  },
});

const CURL_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function parseOne(
  url: string,
  useCurl: boolean | undefined,
): Promise<Awaited<ReturnType<typeof parser.parseString>>> {
  if (useCurl) {
    // 30 秒而非默认 20：实测 TechCrunch / Crunchbase 这类站点在网络拥塞时
    // 会卡到 20 秒以上，白白丢掉一个本来能用的源。
    const xml = await curlFetch(url, CURL_HEADERS, 30);
    return parser.parseString(xml);
  }
  return parser.parseURL(url);
}

/**
 * 两层时间修正：
 *   1. 源级纠偏（tzFixHours）——已知把本地时间标成 GMT 的源，减去差值
 *   2. 通用防线——纠偏后仍在未来 15 分钟以上的，置空不显示。
 *      未来时间戳会在按时间排序的合并列表里永远置顶；而压到抓取时刻
 *      等于编造时间，用户明确不接受。
 */
function fixPublishedAt(
  d: Date | undefined,
  tzFixHours: number | undefined,
  now: Date,
): Date | undefined {
  if (!d || Number.isNaN(d.getTime())) return undefined;
  let t = d.getTime();
  if (tzFixHours) t -= tzFixHours * 3_600_000;
  if (t > now.getTime() + 15 * 60_000) {
    // 纠偏后仍在未来——说明这个源的时区标注有未知问题，真实时间无从得知。
    // 用户要求：拿不到准确时间就不要编。返回 undefined，页面上只显示来源
    // 不显示时间（代价是排序垫底）。同时告警，方便为该源补 tzFixHours。
    console.warn(
      `[rss] 时间戳在未来（${d.toISOString()}），已置空。该源可能需要配置 tzFixHours。`,
    );
    return undefined;
  }
  return new Date(t);
}

export async function fetchRss(
  sourceId: string,
  url: string,
  category: Category,
  options: {
    limit?: number;
    useCurl?: boolean;
    fallbackUrls?: string[];
    tzFixHours?: number;
  } = {},
): Promise<RawArticle[]> {
  const limit = options.limit ?? 30;
  const now = new Date();

  // 依次尝试主地址与备用地址，第一个能解析出条目的胜出。空结果也算失败——
  // RSSHub 镜像限流时会返回一个 HTTP 503 的 HTML 错误页，或一个 0 条目的
  // 合法 feed，两种都不能当成"今天真的没有新闻"。
  const candidates = [url, ...(options.fallbackUrls ?? [])];
  let lastError: unknown;
  let feed: Awaited<ReturnType<typeof parser.parseString>> | undefined;
  // 整个候选列表最多走两轮：第一轮全挂时等 5 秒再来一次。限流和网络抖动
  // 大多是瞬时的，一次重试能捞回不少源。
  outer: for (let round = 0; round < 2; round++) {
    if (round > 0) {
      await new Promise((r) => setTimeout(r, 5_000));
      console.log(`[rss] ${sourceId}: 首轮全部失败，重试一次`);
    }
    for (const [i, candidate] of candidates.entries()) {
      try {
        const attempt = await parseOne(candidate, options.useCurl);
        if ((attempt.items ?? []).length === 0) {
          throw new Error("feed 解析成功但没有条目");
        }
        if (i > 0 || round > 0) {
          console.log(
            `[rss] ${sourceId}: 第 ${round + 1} 轮 · 地址 ${i + 1}/${candidates.length} 成功`,
          );
        }
        feed = attempt;
        break outer;
      } catch (e) {
        lastError = e;
      }
    }
  }
  if (!feed) {
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError ?? "所有地址均失败"));
  }

  return (feed.items ?? [])
    .slice(0, limit)
    .map((item) => ({
      sourceId,
      title: (item.title ?? "").trim(),
      url: (item.link ?? "").trim(),
      // 保留 800 字：摘要要求写 150-250 字，原文却只留 300 字等于逼模型抄原文。
      // 实测 193/373 条正好卡在 300 字上限，说明信息在抓取阶段就被切掉了。
      excerpt: stripHtml(item.contentSnippet ?? item.content ?? "").slice(
        0,
        800,
      ),
      publishedAt: fixPublishedAt(
        item.isoDate ? new Date(item.isoDate) : undefined,
        options.tzFixHours,
        now,
      ),
      category,
    }))
    .filter((a) => a.title && a.url);
}
