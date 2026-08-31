/**
 * 投中网直抓。
 *
 * 投中是国内一级市场的核心媒体之一（融资事件、机构动态、季度/年度统计报告），
 * 但它没有 RSS，RSSHub 的 chinaventure 路由在公共实例上常年 503/429。
 *
 * 好在首页是纯服务端渲染的静态 HTML，列表结构稳定：
 *   <li><a href="/news/113-20260827-392962.html">
 *     <div class="coverimg"><img ...></div>
 *     <h1>蜂巢互联完成12亿元融资</h1>
 *     <h2>数月密集完成两轮总额12亿元。</h2>
 *     <p><span>投中网</span><span> · </span><span>3小时前</span></p>
 *   </a></li>
 *
 * 内容信噪比比 36氪快讯高很多——36氪快讯里混着大量 A 股财报（"某某上半年
 * 净利润 X 亿"），投中基本都是一级市场事件。
 *
 * 发布时间取自 URL 里的日期段（/news/{分类}-{YYYYMMDD}-{id}.html），比页面上
 * 的"3小时前"这类相对时间可靠。缺点是只精确到天，同一天的条目排序会并列。
 */
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PAGE_URL = "https://www.chinaventure.com.cn/index.html";
const BASE = "https://www.chinaventure.com.cn";

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

/** 从 /news/113-20260827-392962.html 里取出发布日期。 */
function dateFromHref(href: string): Date | undefined {
  const m = href.match(/-(\d{4})(\d{2})(\d{2})-/);
  if (!m) return undefined;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T08:00:00+08:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function fetchChinaVenture(
  sourceId: string,
  category: Category,
  limit = 30,
): Promise<RawArticle[]> {
  const html = await curlFetch(PAGE_URL, HEADERS, 30);

  // 逐个 <a href="/news/...">…</a> 块地扫，块内再取 h1 / h2。
  const blockRe =
    /<a[^>]+href="(\/news\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set<string>();
  const out: RawArticle[] = [];

  for (const m of html.matchAll(blockRe)) {
    const href = m[1];
    const inner = m[2];
    if (seen.has(href)) continue;

    const h1 = inner.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    if (!h1) continue;
    const title = decode(h1[1].replace(/<[^>]+>/g, ""));
    if (!title) continue;

    const h2 = inner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const excerpt = h2 ? decode(h2[1].replace(/<[^>]+>/g, "")) : "";

    seen.add(href);
    out.push({
      sourceId,
      title,
      url: href.startsWith("http") ? href : BASE + href,
      excerpt: excerpt.slice(0, 800),
      publishedAt: dateFromHref(href),
      // 该源只提供日期，时刻是排序用的占位——页面只显示日期
      dateOnly: true,
      category,
    });
    if (out.length >= limit) break;
  }

  if (out.length === 0) {
    throw new Error(
      "投中网页面里没解析出条目 —— 列表结构可能改了，需要更新 lib/sources/chinaventure.ts",
    );
  }
  return out;
}
