/**
 * i黑马 直抓。
 *
 * 读者常看的创业与创投媒体，公众号内容与网站基本同步。没有 RSS，
 * 但首页是服务端渲染的静态 HTML，列表结构稳定：
 *
 *   <div class="item-wrap clearfix">
 *     <a href="/article-401140.html" class="pic ..."><img …></a>
 *     <div class="desc ...">
 *       <a class="title" href="/article-401140.html">标题</a>
 *       …
 *
 * 注意标题的 <a> 带 class="title"，页面上同一篇文章会出现两个相同 href
 * 的 <a>（一个包图、一个包标题），所以按 href 去重。
 *
 * 首页不带发布时间，图片 URL 里有日期段（/iheima/20260826/…），但不是每条
 * 都有，所以 publishedAt 多数为空。groupRaw 会把无时间的条目排在有时间的
 * 之后——这是可接受的代价，内容仍会进报告，也仍会参与 AI 分类与简报选条。
 */
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PAGE_URL = "https://www.iheima.com/";
const BASE = "https://www.iheima.com";

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

export async function fetchIheima(
  sourceId: string,
  category: Category,
  limit = 30,
): Promise<RawArticle[]> {
  const html = await curlFetch(PAGE_URL, HEADERS, 30);

  // 整块地扫 item-wrap：块里既有配图（URL 带日期段）也有标题 <a class="title">。
  // 只匹配标题 <a> 的话拿不到时间，条目会全部无日期而在时间排序里垫底。
  const blockRe = /<div class="item-wrap[^"]*">([\s\S]*?)(?=<div class="item-wrap|<\/section|$)/g;
  const seen = new Set<string>();
  const out: RawArticle[] = [];

  for (const b of html.matchAll(blockRe)) {
    const block = b[1];
    const t = block.match(
      /<a[^>]*class="title"[^>]*href="(\/article-\d+\.html)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!t) continue;
    const href = t[1];
    if (seen.has(href)) continue;
    const title = decode(t[2].replace(/<[^>]+>/g, ""));
    if (!title) continue;

    // 配图 URL 形如 //a1.heimadata.com/iheima/20260826/<hash>
    const dm = block.match(/\/iheima\/(\d{4})(\d{2})(\d{2})\//);
    const publishedAt = dm
      ? new Date(`${dm[1]}-${dm[2]}-${dm[3]}T09:00:00+08:00`)
      : undefined;

    seen.add(href);
    out.push({
      sourceId,
      title,
      url: BASE + href,
      excerpt: "",
      publishedAt:
        publishedAt && !Number.isNaN(publishedAt.getTime())
          ? publishedAt
          : undefined,
      // 该源只提供日期，时刻是排序用的占位——页面只显示日期
      dateOnly: true,
      category,
    });
    if (out.length >= limit) break;
  }

  if (out.length === 0) {
    throw new Error(
      "i黑马首页没解析出条目 —— 列表结构可能改了，需要更新 lib/sources/iheima.ts",
    );
  }
  return out;
}
