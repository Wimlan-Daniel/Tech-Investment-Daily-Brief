/**
 * 逐条内容分类——本 fork 相对上游最核心的改动。
 *
 * 为什么需要这一层：
 *   上游按"信源"分板块（某个源固定属于 tech / finance / politics）。这在信源
 *   本身性质单一时够用，但对本项目不成立。实测 36氪快讯同一天里既有「某公司完成
 *   A 轮融资」（一级市场），也有「某某上市公司上半年净利润 29 亿」（二级市场财报），
 *   还有「某游戏制作人离职」（无关噪音）。按来源分，三者会被塞进同一个板块。
 *
 * 所以这里在抓取之后、渲染之前插一步：把每条标题+摘要交给模型，判断它真正属于
 * 哪个板块，或者判定为噪音直接丢弃。分类结果覆写 article.category，下游的分组、
 * 摘要、渲染逻辑完全不用改。
 *
 * 成本控制：一次批量调用处理 CHUNK_SIZE 条，只发标题和摘要前 160 字，不发正文。
 */
import { runLlm } from "./llm";
import { extractJson } from "./json-util";
import type { ArticleInput } from "./pipeline";
import type { Category } from "../sources/types";
import { ALL_CATEGORIES } from "../sources/types";

/** 每批送多少条给模型。太大容易触发输出截断导致 JSON 解析失败。 */
const CHUNK_SIZE = 60;

/**
 * 同时跑几批。每个并发都是一个独立的 claude 进程。
 *
 * 实测：4 路并发会被限流打爆——第 1 批直接返回 API Error，第 2-4 批全部
 * 300 秒超时；而串行时每批稳定 100-170 秒。2 路是速度与稳定的折中。
 * 出现大面积超时就往下调到 1。
 */
const CONCURRENCY = 2;

/** 单批失败后的重试次数。分类失败意味着这一批内容全部落到兜底板块，值得重试。 */
const RETRIES = 2;

/** 分类失败时的兜底板块——宁可进这里也不要丢内容。 */
const FALLBACK: Category = "global-business";

const SYSTEM_PROMPT = `你是一名服务于中国一级市场（VC/PE）前沿科技投资人的资讯编辑，负责把当日抓取的资讯逐条分拣到正确的板块，并剔除对他没有价值的噪音。

读者画像：在中国做早中期前沿科技投资，关注人工智能、具身智能与机器人、半导体与算力、生物医药与合成生物、新能源新材料、航天与深科技。他不炒股做交易，但需要了解资本市场环境。

五个板块的定义与边界：

1. frontier-tech（前沿技术）
   技术本身走到哪一步了。论文与研究成果、模型能力突破、技术路线之争、benchmark 与
   评测、算法与架构创新、实验室阶段的科研进展、开源项目的技术价值。
   判断关键词：这条讲的是"能做到什么了"。

2. tech-business（科技商业）
   前沿科技公司除技术本身之外的一切商业进展。新模型/新产品/新机器人的发布与上市、
   定价与商业模式、客户与落地案例、产能与量产、供应链、合作与联盟、人事变动、
   公司战略转向、算力采购与数据中心建设。
   判断关键词：这条讲的是"技术变成生意了"。
   与 1 的边界：一个新模型发布，如果重点在能力提升多少，归 1；如果重点在发布本身、
   价格、可用性、谁在用，归 2。两边都沾时看行文重心。

3. china-vc（中国一级市场）
   未上市公司的融资事件（各轮次）、基金募集与关账、并购与退出、IPO 申报与过会、
   创投相关政策与监管、一级市场统计数据与研究报告（清科、投中、IT桔子等机构发布）。
   以中国为主，美国等海外的重大一级市场事件（尤其是前沿科技赛道的大额融资、
   知名机构动作）也归这里。

4. capital-markets（资本市场）
   已上市公司与二级市场。A股/港股/美股行情与指数、上市公司财报与业绩、
   增减持与股权变动、宏观经济数据、货币与利率政策、汇率、大宗商品。

5. global-business（全球商业）
   不属于上述四类、但按《金融时报》头版标准值得放上重要版面的全球商业事件。
   大额并购、行业格局重塑、巨头战略转向、重大监管处罚与反垄断、供应链与贸易变动、
   出口管制与制裁、影响产业的地缘政治事件。

6. drop（丢弃）—— 不是板块，是剔除标记
   对上述读者没有价值的内容一律标 drop：娱乐八卦、体育、明星与网红、社会新闻、
   生活消费、游戏娱乐圈人事、纯软文与广告、标题党、与科技和商业无关的国际时政、
   重复度极高的例行公告。

输出严格遵循以下 JSON，不要 markdown 包裹，不要任何前后缀说明：
{
  "items": [
    { "i": <输入条目的 i 值，原样回填>, "c": "<frontier-tech|tech-business|china-vc|capital-markets|global-business|drop>" },
    ...
  ]
}

规则：
1. 必须为输入的**每一条**都给出结果，不能漏，不能合并，条数必须一致。
2. i 必须严格回填输入值，不要重新编号。
3. 每条只能归一个板块。边界模糊时，选行文重心更偏的那个，不要犹豫。
4. 宁严勿滥：拿不准是否有价值时，倾向判 drop。读者时间有限，漏掉一条边缘内容的
   代价，远小于每天被几十条噪音淹没。
5. 不要输出解释、理由或任何额外字段。`;

interface ClassifyResult {
  items?: { i?: number; c?: string }[];
}

const VALID = new Set<string>([...ALL_CATEGORIES, "drop"]);

/**
 * 就地覆写 articles 里每条的 category，并返回应当保留的条目。
 * 被判为 drop 的条目不会出现在返回数组里。
 *
 * 单批失败时该批全部保留（category 维持源配置的兜底值），不会因为一次
 * LLM 抖动就丢掉当天的内容。
 */
export async function classifyArticles(
  articles: ArticleInput[],
): Promise<ArticleInput[]> {
  if (articles.length === 0) return [];

  const verdict = new Map<number, string>();
  const chunks: ArticleInput[][] = [];
  for (let i = 0; i < articles.length; i += CHUNK_SIZE) {
    chunks.push(articles.slice(i, i + CHUNK_SIZE));
  }

  console.log(
    `[classify] 开始分类 ${articles.length} 条，分 ${chunks.length} 批，并发 ${CONCURRENCY}`,
  );

  // 并行跑批次。claude CLI 每次调用要 100-170 秒（进程启动 + 模型推理），
  // 串行 13 批就是近半小时。批次之间互相独立，并行是安全的。
  // 并发数不宜过高——每个并发都是一个独立的 claude 进程，太多会撞速率限制。
  let done = 0;
  const runBatch = async (chunk: ArticleInput[], batchNo: number) => {
    const offset = batchNo * CHUNK_SIZE;
    const payload = chunk.map((a, k) => ({
      i: offset + k,
      title: a.title,
      desc: (a.summary ?? a.excerpt ?? "").slice(0, 160),
      from: a.sourceId,
    }));
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const { text } = await runLlm({
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: [
            `下面是 ${payload.length} 条待分类资讯，请为每一条给出板块。`,
            JSON.stringify(payload),
            "",
            `再次强调：输出的 items 数组必须刚好 ${payload.length} 条，i 原样回填。`,
          ].join("\n"),
          // 实测成功调用平均 144 秒、最慢 243 秒（2 路并发下），300 秒线太紧，
        // 会把本来快跑完的批次误杀。放到 480 秒。
        timeoutMs: 480_000,
        });
        const parsed = JSON.parse(extractJson(text)) as ClassifyResult;
        let hits = 0;
        for (const it of parsed.items ?? []) {
          if (typeof it?.i !== "number" || typeof it?.c !== "string") continue;
          if (!VALID.has(it.c)) continue;
          verdict.set(it.i, it.c);
          hits++;
        }
        console.log(
          `[classify] 批次 ${batchNo + 1} 完成（${++done}/${chunks.length}）：${hits}/${payload.length} 条有结果`,
        );
        return;
      } catch (e) {
        const last = attempt === RETRIES;
        if (last) {
          // 重试用尽——这批条目走兜底路径保留下来，不丢内容
          console.warn(
            `[classify] 批次 ${batchNo + 1} 最终失败（${++done}/${chunks.length}），该批保留原板块：${String(e).slice(0, 160)}`,
          );
          return;
        }
        // 退避后重试。限流通常是瞬时的，等一会儿就好。
        const waitMs = 20_000 * (attempt + 1);
        console.warn(
          `[classify] 批次 ${batchNo + 1} 第 ${attempt + 1} 次失败，${waitMs / 1000}s 后重试：${String(e).slice(0, 120)}`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  };

  const queue = chunks.map((c, i) => [c, i] as const);
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await runBatch(next[0], next[1]);
      }
    }),
  );

  const kept: ArticleInput[] = [];
  const tally: Record<string, number> = { drop: 0, unclassified: 0 };
  for (const [idx, a] of articles.entries()) {
    const c = verdict.get(idx);
    if (c === "drop") {
      tally.drop++;
      continue;
    }
    if (c === undefined) {
      // 模型没给结果（批次失败或漏条）——保留，用源配置里的兜底板块
      tally.unclassified++;
      if (!ALL_CATEGORIES.includes(a.category)) a.category = FALLBACK;
    } else {
      a.category = c as Category;
    }
    tally[a.category] = (tally[a.category] ?? 0) + 1;
    kept.push(a);
  }

  console.log(
    `[classify] 完成：保留 ${kept.length} / ${articles.length}，剔除噪音 ${tally.drop} 条` +
      (tally.unclassified ? `，未分类沿用兜底 ${tally.unclassified} 条` : ""),
  );
  for (const c of ALL_CATEGORIES) {
    console.log(`[classify]   ${c.padEnd(17)} ${tally[c] ?? 0} 条`);
  }
  return kept;
}
