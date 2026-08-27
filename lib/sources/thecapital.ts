/**
 * 融中财经（thecapital.com.cn）直抓。
 *
 * 《融资中国》杂志的官网，定位是股权投资与产业投资媒体，内容以机构动态、
 * 基金募集、LP/GP 关系为主——这块是 36氪、投中都覆盖得比较薄的角度。
 *
 * 官网是 Vue 服务端渲染（Nuxt 风格），首页 HTML 里已带列表数据。结构：
 *
 *   <a target="_blank" href="/newsDetail/124723">
 *     …<div class="… ellipse2"> 标题 </div>
 *       <div class="… ellipse1"> 摘要（常为空） </div>
 *       <div class="text-f14 fc-6"> 2026年08月26日 | 美通社 </div>
 *
 * 注意：`/news` 子页是纯前端路由（只有 40 个中文字），抓不到内容，
 * 必须抓首页。
 */
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PAGE_URL = "https://www.thecapital.com.cn/";
const BASE = "https://www.thecapital.com.cn";

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

/** "2026年08月26日" → Date（按北京时间早 9 点，只精确到天） */
function parseCnDate(s: string): Date | undefined {
  const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return undefined;
  const d = new Date(
    `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}T09:00:00+08:00`,
  );
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function fetchTheCapital(
  sourceId: string,
  category: Category,
  limit = 30,
): Promise<RawArticle[]> {
  const html = await curlFetch(PAGE_URL, HEADERS, 30);

  const blockRe =
    /<a[^>]+href="(\/newsDetail\/\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set<string>();
  const out: RawArticle[] = [];

  for (const m of html.matchAll(blockRe)) {
    const href = m[1];
    if (seen.has(href)) continue;
    const inner = m[2];

    // 标题在 class 含 ellipse2 的 div 里
    const t = inner.match(/<div[^>]*ellipse2[^>]*>([\s\S]*?)<\/div>/);
    if (!t) continue;
    const title = decode(t[1].replace(/<[^>]+>/g, ""));
    if (!title) continue;

    // 摘要在 ellipse1 里，站上大多为空
    const e = inner.match(/<div[^>]*ellipse1[^>]*>([\s\S]*?)<\/div>/);
    const excerpt = e ? decode(e[1].replace(/<[^>]+>/g, "")) : "";

    // 日期形如 "2026年08月26日 | 美通社"。原本只认第一个 text-f14 的 div，
    // 但那个位置在部分条目里是别的内容，导致日期时有时无——直接在整块里
    // 搜日期模式更稳。
    const publishedAt = parseCnDate(decode(inner.replace(/<[^>]+>/g, " ")));

    seen.add(href);
    out.push({
      sourceId,
      title,
      url: BASE + href,
      excerpt: excerpt.slice(0, 300),
      publishedAt,
      category,
    });
    if (out.length >= limit) break;
  }

  if (out.length === 0) {
    throw new Error(
      "融中财经首页没解析出条目 —— 列表结构可能改了，需要更新 lib/sources/thecapital.ts",
    );
  }
  return out;
}
