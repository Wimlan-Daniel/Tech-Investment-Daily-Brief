/**
 * 语义判重：把报道同一事件的条目合并成一条。
 *
 * 为什么标题判重不够：
 *   dedupeByTitle 只合并标题完全相同的转载。但实测大量重复是**同一事件的
 *   不同写法**，标题字面完全不同：
 *     · a16z 同一笔追加募资 →「成长基金追加至85亿美元」（TechCrunch）
 *                            「为第五期成长基金追加募资17.5亿美元」（The Information）
 *     · 香山股份同一份公告 →「跨界AI！香山股份拟购买武珞智慧100%股份 股票停牌」
 *                            「停牌！香山股份筹划收购AI智算公司 8月大涨近40%」
 *       —— 这两条甚至来自同一个源、同一个时间戳。
 *
 * 只发标题不发正文：一次调用就能覆盖全部条目，成本和延迟都可忽略。
 * 判断"是不是同一件事"看标题足够，不需要读全文。
 *
 * 保留哪一条：第一手信源 > 有 AI 摘要 > 摘要更长 > 有发布时间。
 * 转载与二次加工的版本往往删节、改标题、丢时间戳。
 *
 * 失败不阻断：判重失败就全部保留，页面上多几条重复远好过整轮挂掉。
 */
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import type { ArticleInput } from "./pipeline";
import { sources } from "../sources/registry";

const SYSTEM_PROMPT = `你是一名资讯编辑，负责找出报道**同一事件**的重复条目。

输入是一批资讯标题，每条带编号 i、来源 from 和板块 cat。

任务：把报道同一事件的条目分组。判断标准是**它们说的是不是同一件事**，
而不是标题像不像。

算重复的例子：
  · 「a16z成长基金追加至85亿美元」与「a16z为第五期成长基金追加募资17.5亿美元，累计达85亿美元」
    —— 同一笔募资，一个说结果一个说增量
  · 「跨界AI！香山股份拟购买武珞智慧100%股份 股票停牌」与「停牌！香山股份筹划收购AI智算公司」
    —— 同一份公告的两种写法
  · 同一家公司同一轮融资被多家媒体报道

**不算重复**（这些必须分开保留）：
  · 同一家公司的不同事件（完成融资 / 发布产品 / 高管变动）
  · 同一事件的不同阶段（宣布洽谈 / 签署协议 / 交易完成）
  · 同一主题的不同角度，且各自带有对方没有的实质信息
    （例：「某公司完成B轮」与「某公司B轮估值披露为X亿」——后者有新增数据）
  · 泛泛的行业综述与具体的单个事件

输出严格 JSON，不要 markdown 包裹：
{
  "groups": [[3, 17], [22, 45, 51], ...]
}

规则：
1. 每个数组是一组重复条目的编号，**至少 2 个**才算一组。
2. 没有任何重复时返回 {"groups": []}。
3. 一个编号最多出现在一组里。
4. 拿不准是否同一事件时**不要合并**——漏合并只是多一条，错合并会丢信息。
5. 不要输出解释或任何额外字段。`;

interface DedupeResult {
  groups?: number[][];
}

/**
 * 保留优先级打分。
 *
 * 注意判重在流水线里跑在**摘要之前**，此刻所有条目都还没有 summary，
 * 所以打分只能依赖那一刻真实可得的信息：信源层级、标题、原文摘录。
 * （summary 分支保留是为了 regen 等场景复用本函数时仍然正确。）
 *
 * 权重：第一手信源 > 硬信息密度 > 原文完整度 > 有发布时间。
 *
 * 硬信息密度指标题与原文里金额、轮次、百分比这类数字的个数——同为媒体
 * 报道时，带具体数字的版本信息量通常更大。但要说明它并非万能：a16z 追加
 * 募资那组两个标题各含 2 个数字，打平，最终由原文完整度决出，两条内容
 * 都完整，留哪条都不损失信息。这个指标解决的是「一条有数字一条没有」
 * 的情况，不是所有情况。
 */
function qualityScore(a: ArticleInput, firstParty: Set<string>): number {
  const text = `${a.title} ${a.summary ?? ""}`;
  // 金额、轮次、百分比、倍数这类硬数字的个数
  const numHits = (
    text.match(/\d+(\.\d+)?\s*(亿|万|%|倍|轮|美元|元|港元)/g) ?? []
  ).length;
  return (
    (firstParty.has(a.sourceId) ? 100 : 0) +
    (a.summary ? 50 : 0) +
    Math.min(numHits * 6, 36) +
    Math.min((a.summary ?? a.excerpt ?? "").length / 20, 15) +
    (a.publishedAt ? 5 : 0)
  );
}

export async function dedupeBySemantics(
  articles: ArticleInput[],
): Promise<ArticleInput[]> {
  if (articles.length < 2) return articles;

  const firstParty = new Set(
    sources.filter((s) => s.tier === "first").map((s) => s.id),
  );
  const payload = articles.map((a, i) => ({
    i,
    t: a.title,
    from: a.source,
    cat: a.category,
  }));

  let groups: number[][] = [];
  try {
    const { text } = await runLlm({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: [
        `下面 ${payload.length} 条资讯标题，找出报道同一事件的重复分组。`,
        JSON.stringify(payload),
        "",
        "只输出 JSON，groups 里每组至少 2 个编号。",
      ].join("\n"),
      timeoutMs: 300_000,
    });
    const parsed = JSON.parse(extractJson(text)) as DedupeResult;
    groups = (parsed.groups ?? []).filter(
      (g) => Array.isArray(g) && g.length >= 2,
    );
  } catch (e) {
    // 判重失败就全部保留——多几条重复远好过整轮挂掉
    console.warn(
      `[dedupe] 语义判重失败，本轮跳过：${String(e).slice(0, 140)}`,
    );
    return articles;
  }

  const drop = new Set<number>();
  let merged = 0;
  for (const g of groups) {
    const valid = g.filter((i) => Number.isInteger(i) && i >= 0 && i < articles.length);
    if (valid.length < 2) continue;
    // 组内保留质量最高的那条，其余丢弃
    let keep = valid[0];
    for (const i of valid) {
      if (
        qualityScore(articles[i], firstParty) >
        qualityScore(articles[keep], firstParty)
      ) {
        keep = i;
      }
    }
    for (const i of valid) {
      if (i !== keep && !drop.has(i)) {
        drop.add(i);
        merged++;
      }
    }
  }

  if (merged > 0) {
    console.log(
      `[dedupe] 语义判重：${groups.length} 组同一事件，合并掉 ${merged} 条`,
    );
  } else {
    console.log("[dedupe] 语义判重：未发现同一事件的重复条目");
  }
  return articles.filter((_, i) => !drop.has(i));
}
