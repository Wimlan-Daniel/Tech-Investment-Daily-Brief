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
    const xml = await curlFetch(url, CURL_HEADERS);
    return parser.parseString(xml);
  }
  return parser.parseURL(url);
}

export async function fetchRss(
  sourceId: string,
  url: string,
  category: Category,
  options: {
    limit?: number;
    useCurl?: boolean;
    fallbackUrls?: string[];
  } = {},
): Promise<RawArticle[]> {
  const limit = options.limit ?? 30;

  // 依次尝试主地址与备用地址，第一个能解析出条目的胜出。空结果也算失败——
  // RSSHub 镜像限流时会返回一个 HTTP 503 的 HTML 错误页，或一个 0 条目的
  // 合法 feed，两种都不能当成"今天真的没有新闻"。
  const candidates = [url, ...(options.fallbackUrls ?? [])];
  let lastError: unknown;
  let feed: Awaited<ReturnType<typeof parser.parseString>> | undefined;
  for (const [i, candidate] of candidates.entries()) {
    try {
      const attempt = await parseOne(candidate, options.useCurl);
      if ((attempt.items ?? []).length === 0) {
        throw new Error("feed 解析成功但没有条目");
      }
      if (i > 0) {
        console.log(
          `[rss] ${sourceId}: 主地址失败，改用备用地址 ${i}/${candidates.length - 1} 成功`,
        );
      }
      feed = attempt;
      break;
    } catch (e) {
      lastError = e;
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
      excerpt: stripHtml(item.contentSnippet ?? item.content ?? "").slice(
        0,
        300,
      ),
      publishedAt: item.isoDate ? new Date(item.isoDate) : undefined,
      category,
    }))
    .filter((a) => a.title && a.url);
}
