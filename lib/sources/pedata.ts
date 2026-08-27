/**
 * 清科研究中心免费报告列表。
 *
 * 这个源解决的是"一级市场结构化数据"的缺口。IT桔子、烯牛数据、私募通都是
 * 付费数据库，公开接口全部拒绝访问；`www.pedata.cn` 本体是 Vue 单页应用，
 * 纯 HTTP 抓只能拿到空壳。
 *
 * 但 `free.pedata.cn` 是服务端渲染的静态列表，而且**标题本身就是数据**：
 *   「清科数据周报：本周投资、退出、并购事件共265起，涉及金额1974.62亿元
 *     （2026年08月15日-2026年08月21日）」
 *   「清科数据月报：7月投资、退出、并购事件共1301起，涉及金额22556.76亿元」
 *
 * 事件数和总金额直接写在标题里，周报每周更新、月报每月更新。拿不到明细，
 * 但总量口径的趋势足够判断一级市场冷热。
 *
 * 注意更新频率是周级，所以 scripts/daily.ts 的 7 天时间窗刚好能覆盖到最新
 * 一期；把窗口调窄到 3 天以内的话这个源大部分时候会是空的。
 */
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PAGE_URL = "https://free.pedata.cn/";

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

export async function fetchPedataReports(
  sourceId: string,
  category: Category,
  limit = 20,
): Promise<RawArticle[]> {
  const html = await curlFetch(PAGE_URL, HEADERS, 30);

  // 每条形如：
  //   <div class="gw_report_one">
  //     <a href="https://free.pedata.cn/1440998437474231.html"><h2>标题</h2></a>
  //     <div class="news_all_time"><span>发布时间：2026-08-24</span>…</div>
  const blockRe = /<div class="gw_report_one">([\s\S]*?)<div class="gw_report_btn">/g;
  const out: RawArticle[] = [];

  for (const m of html.matchAll(blockRe)) {
    const block = m[1];
    const link = block.match(/<a[^>]+href="([^"]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!link) continue;
    const url = link[1];
    const title = decode(link[2].replace(/<[^>]+>/g, ""));
    if (!title || !url) continue;

    const dm = block.match(/发布时间：\s*(\d{4})-(\d{2})-(\d{2})/);
    const publishedAt = dm
      ? new Date(`${dm[1]}-${dm[2]}-${dm[3]}T09:00:00+08:00`)
      : undefined;

    out.push({
      sourceId,
      title,
      url,
      // 列表页的 <p> 就是标题重复，没有额外信息，所以不取，留空即可
      excerpt: "",
      publishedAt:
        publishedAt && !Number.isNaN(publishedAt.getTime())
          ? publishedAt
          : undefined,
      category,
    });
    if (out.length >= limit) break;
  }

  if (out.length === 0) {
    throw new Error(
      "清科免费报告页没解析出条目 —— 列表结构可能改了，需要更新 lib/sources/pedata.ts",
    );
  }
  return out;
}
