/**
 * 36氪快讯直抓。
 *
 * 背景：36氪官方 RSS 早已下线，社区方案一律走 RSSHub 公共镜像，而这些镜像
 * 会被 36氪上游间歇性封锁——实测同一个地址上午可用、下午全部 503。把一级
 * 市场的主力信源押在别人的公共实例上，不是个能长期跑的方案。
 *
 * 好在 36氪的快讯页是服务端渲染的：整页数据以 JSON 内嵌在
 * `window.initialState=` 里，直接解析即可，不需要浏览器执行 JS。
 *
 * 注意必须用带 www 的域名：
 *   https://www.36kr.com/newsflashes   → 113KB，含完整数据 ✅
 *   https://36kr.com/newsflashes       → 17KB，只有 SPA 空壳 ❌
 *
 * 拿到的字段比 RSS 更全：标题、快讯全文、精确到毫秒的发布时间、条目 ID。
 */
import { curlFetch } from "./curl-fetch";
import type { Category, RawArticle } from "./types";

const PAGE_URL = "https://www.36kr.com/newsflashes";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

interface KrItem {
  itemId?: number;
  templateMaterial?: {
    itemId?: number;
    widgetTitle?: string;
    widgetContent?: string;
    publishTime?: number;
  };
}

/**
 * 页面结构可能随版本调整，所以不写死路径，递归找第一个像快讯列表的数组：
 * 元素带 templateMaterial.widgetTitle 即认为命中。
 */
function findItemList(node: unknown, depth = 0): KrItem[] | null {
  if (depth > 8 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    const looksRight =
      node.length > 0 &&
      node.every(
        (x) =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as KrItem).templateMaterial?.widgetTitle === "string",
      );
    if (looksRight) return node as KrItem[];
    for (const child of node) {
      const hit = findItemList(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    const hit = findItemList(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export async function fetch36krNewsflash(
  sourceId: string,
  category: Category,
  limit = 30,
): Promise<RawArticle[]> {
  const html = await curlFetch(PAGE_URL, HEADERS, 30);

  const m = html.match(/window\.initialState=(\{.*?\})<\/script>/s);
  if (!m) {
    throw new Error(
      "36氪页面里找不到 window.initialState —— 页面结构可能改了，需要更新 lib/sources/kr36.ts",
    );
  }

  let state: unknown;
  try {
    state = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`36氪 initialState 解析失败: ${(e as Error).message}`);
  }

  const items = findItemList(state);
  if (!items || items.length === 0) {
    throw new Error("36氪 initialState 里没找到快讯列表");
  }

  return items
    .slice(0, limit)
    .map((it) => {
      const t = it.templateMaterial ?? {};
      const id = t.itemId ?? it.itemId;
      const title = (t.widgetTitle ?? "").trim();
      if (!title || !id) return null;
      return {
        sourceId,
        title,
        url: `https://www.36kr.com/newsflashes/${id}`,
        excerpt: (t.widgetContent ?? "").replace(/\s+/g, " ").trim().slice(0, 800),
        publishTime: t.publishTime,
        publishedAt: t.publishTime ? new Date(t.publishTime) : undefined,
        category,
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .map(({ publishTime: _drop, ...rest }) => rest);
}
