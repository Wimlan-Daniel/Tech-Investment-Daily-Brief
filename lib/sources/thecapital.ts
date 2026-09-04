/**
 * 融中财经（thecapital.com.cn）直抓。
 *
 * 《融资中国》杂志的官网，定位是股权投资与产业投资媒体，内容以机构动态、
 * 基金募集、LP/GP 关系为主——这块是 36氪、投中都覆盖得比较薄的角度。
 *
 * ── 2026-09-04 重写：站点整体迁到 Nuxt 3，三处都变了 ────────────
 *   1. 首页 `/` 只剩 93 字节的 meta 跳转壳子，真正的列表在 `/home/0`
 *   2. 列表不再是 HTML 里的 <a href="/newsDetail/..."> 锚点，改成
 *      <script id="__NUXT_DATA__"> 里的一段 JSON
 *   3. 详情页地址 `/newsDetail/{id}` → `/news/{id}`（旧地址现在 404）
 *   旧版按 class 名（ellipse2 / ellipse1）扒 HTML，改版后一条也解析不出来。
 *
 * ── 为什么解析 JSON 反而更稳 ─────────────────────────────────────
 * 新结构给的是结构化字段，比扒 class 名可靠得多，而且多拿到两样东西：
 *   · publishTime 是 Unix 秒，精确到分钟——旧版只能从「2026年08月26日」
 *     取到天，所以当时得打 dateOnly 标记。现在有真实时刻，标记可以去掉。
 *   · description 是编辑写的导语，旧版的 ellipse1 基本都是空的。
 *
 * ── __NUXT_DATA__ 的格式 ─────────────────────────────────────────
 * Nuxt 3 用的是「扁平化 + 引用」的 payload：整个 JSON 是一个大数组，
 * 对象的每个值不是真实数据，而是指向数组另一位置的下标。所以取数据要
 * 顺着下标递归展开（见 deref）。这么做是为了让重复出现的字符串只存一份。
 *
 * 列表在 data["homePageData-/home/0"].newsList，另有 topNewsList 三条置顶。
 */
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PAGE_URL = "https://www.thecapital.com.cn/home/0";
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

/** Nuxt payload 里包一层的响应式标记，展开时要透传而不是当数组处理 */
const REACTIVE_TAGS = new Set([
  "ShallowReactive",
  "Reactive",
  "Ref",
  "ShallowRef",
  "EmptyRef",
]);

/**
 * 把扁平 payload 里的下标递归展开成普通对象。
 *
 * depth 上限是防环——payload 里对象可以互相引用，没有上限会栈溢出。
 * 12 层足够到达 newsList 的字段（root → data → homePageData → newsList
 * → 条目 → 字段，实际只用 6 层）。
 */
function deref(data: unknown[], i: unknown, depth = 0): unknown {
  if (typeof i !== "number" || i < 0 || i >= data.length) return i;
  if (depth > 12) return undefined;
  const v = data[i];
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "string" && REACTIVE_TAGS.has(v[0])) {
      return deref(data, v[1], depth);
    }
    return v.map((x) => deref(data, x, depth + 1));
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = deref(data, x, depth + 1);
    }
    return out;
  }
  return v;
}

interface NewsItem {
  id?: number;
  title?: string;
  description?: string;
  /** Unix 秒，但站上是**字符串**形式，如 "1788486000"。别按 number 判断 */
  publishTime?: string | number;
  /** "2026-09-04 09:40"，北京时间。publishTime 缺失时的备用 */
  publishDate?: string;
  source?: string;
}

/**
 * 取发布时间。
 *
 * publishTime 是 Unix 秒但存成字符串——实测 1788486000 对应站上显示的
 * 2026-09-04 09:40，是真 UTC 时间戳，不需要额外做时区平移。
 * 它缺失或为 0 时退回 publishDate（"2026-09-04 09:40"，北京时间）。
 * 两个都取不到就返回 undefined，让下游按「无发布时间」处理，
 * 而不是记成 1970 年顶到排序最前面。
 */
function parsePublishedAt(it: NewsItem): Date | undefined {
  const secs = Number(it.publishTime);
  if (Number.isFinite(secs) && secs > 0) {
    const d = new Date(secs * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const m = String(it.publishDate ?? "").match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/,
  );
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function asNewsList(v: unknown): NewsItem[] {
  return Array.isArray(v) ? (v as NewsItem[]) : [];
}

export async function fetchTheCapital(
  sourceId: string,
  category: Category,
  limit = 30,
): Promise<RawArticle[]> {
  const html = await curlFetch(PAGE_URL, HEADERS, 30);

  const m = html.match(/id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error(
      "融中财经页面里找不到 __NUXT_DATA__ —— 站点结构可能又改了，需要更新 lib/sources/thecapital.ts",
    );
  }

  let root: Record<string, unknown>;
  try {
    const data = JSON.parse(m[1]) as unknown[];
    root = deref(data, 0) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `融中财经 __NUXT_DATA__ 解析失败：${String(e).slice(0, 120)} —— 需要更新 lib/sources/thecapital.ts`,
    );
  }

  const page = (root?.data as Record<string, unknown> | undefined)?.[
    "homePageData-/home/0"
  ] as Record<string, unknown> | undefined;

  // 置顶三条排在前面，再接常规列表
  const items = [
    ...asNewsList(page?.topNewsList),
    ...asNewsList(page?.newsList),
  ];

  const seen = new Set<number>();
  const out: RawArticle[] = [];
  for (const it of items) {
    if (!it || typeof it.id !== "number" || seen.has(it.id)) continue;
    const title = decode(String(it.title ?? ""));
    if (!title) continue;
    seen.add(it.id);

    const publishedAt = parsePublishedAt(it);

    out.push({
      sourceId,
      title,
      url: `${BASE}/news/${it.id}`,
      excerpt: decode(String(it.description ?? "")).slice(0, 800),
      publishedAt,
      category,
    });
    if (out.length >= limit) break;
  }

  if (out.length === 0) {
    throw new Error(
      "融中财经 __NUXT_DATA__ 里没有 newsList —— 站点结构可能又改了，需要更新 lib/sources/thecapital.ts",
    );
  }
  return out;
}
