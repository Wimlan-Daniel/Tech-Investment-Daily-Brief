/**
 * 读取历史简报的条目标题，供简报环节做跨天判重。
 *
 * 单独成文件是因为 scripts/daily.ts 和 scripts/regen-digest.ts 都要用它，
 * 而 daily.ts 在模块加载时就会跑 main()，不能被 import。两处各抄一份的话
 * 迟早会漂移——这个函数的窗口长度一旦和候选池对不上就会静默出问题，
 * 正是下面注释里说的那种 bug。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 候选池窗口：只有这个天数之内的资讯会进入分类与展示。
 * 判重清单必须用同一个值，见下方说明。
 */
export const RECENT_DAYS = 7;

/**
 * 收集最近 lookbackDays 天简报的条目标题，作为判重清单。
 *
 * 判重只和「读者实际看过的简报」比对，不看文章发布日期——按日期打折会误伤
 * 从没上过榜的消息（读者没见过，对他就是新的）。
 *
 * ── 为什么回溯 7 天，而不是只看最近一期 ──────────────────────────
 * 候选池的窗口就是 RECENT_DAYS = 7 天：一篇 7 天前的文章只要还挂在源站
 * RSS 里，每天都会重新进池。而这个清单原先只取最近一期，等于「池子记 7 天、
 * 判重记 1 天」，中间 6 天是盲区——清单里没有的旧事件，模型无从知道报过没有，
 * 于是按全新消息高分选入。
 *
 * 实测后果（2026-08-27 ~ 09-03，共 6 轮）：
 *   · 英伟达 129 亿美元收购 Hugging Face（极客公园 8/27 发布）上了 5 次头条：
 *     8/27 The Information 10 分、8/28 投中网 7 分、8/31 极客公园 9 分、
 *     9/1 钛媒体 9 分、9/3 极客公园 9 分——每次换个源、换个写法
 *   · 同期另有 3 组跨天重复：Anthropic 450 亿算力、Anthropic 1300 亿募资、
 *     8月制造业 PMI
 * 两个窗口对齐后盲区消失。清单从约 10 条涨到约 53 条，多约 1.4k 字符，
 * 只影响简报这一次调用（整轮 21 次调用里的 1 次），不到总输入量的 0.2%。
 *
 * 标题按 normalize 去重：同一条被原样重跑过时不该在清单里占两行。改写过的
 * 标题（8/31「分发权」→ 9/3「分发入口」）normalize 后并不相等，会各占一行
 * ——这是有意的，让模型多看到一种写法，判重反而更稳。
 *
 * 倒序排列，最近的在前。
 */
export function loadPreviousBriefTitles(
  todayDate: string,
  outputDir: string,
  lookbackDays: number = RECENT_DAYS,
): string[] {
  const norm = (t: string) =>
    t.replace(/[\s　]+/g, "").replace(/[「」『』“”"'’‘·・…—\-—–]/g, "").toLowerCase();
  const earliest = new Date(
    Date.parse(`${todayDate}T00:00:00Z`) - lookbackDays * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const titles: string[] = [];
  const seen = new Set<string>();
  try {
    const dirs = fs
      .readdirSync(outputDir)
      .filter(
        (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < todayDate && d >= earliest,
      )
      .sort()
      .reverse();
    for (const d of dirs) {
      const f = path.join(outputDir, d, `${d}.json`);
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, "utf8")) as {
        top_briefs?: { title?: string }[];
      };
      for (const b of j.top_briefs ?? []) {
        const t = b?.title;
        if (!t) continue;
        const k = norm(t);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        titles.push(t);
      }
    }
  } catch {
    // 判重清单拿不到不该阻断整个流程——没有清单时模型按全新消息处理
  }
  return titles;
}
