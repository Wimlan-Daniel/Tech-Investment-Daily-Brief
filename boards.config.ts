/**
 * ============================================================================
 *  板块配置 —— 想增删板块、改名字、改条数，只改这一个文件
 * ============================================================================
 *
 * 改这里之后，下面这些地方会自动跟着变，不需要你再动别的文件：
 *   - 页面上的标签页名称与排列顺序
 *   - 每个板块显示多少条
 *   - AI 分类时的板块定义（lib/ai/classify.ts 会用 definition 字段拼提示词）
 *   - 每日简报里给每条打的板块标签
 *   - TypeScript 的类型检查
 *
 * 合并成一个文件之前，加一个板块要改 3 个文件 7 处，漏改一处不会报错、
 * 只会静默出问题（比如内容抓到了但页面上不显示）。
 *
 * ── 怎么加一个板块 ────────────────────────────────────────────────
 *   在 BOARDS 数组里加一项即可，四个字段都必填：
 *     id         英文短名，只能小写字母和连字符。会出现在网页的 HTML 里
 *     label      中文标签名，显示在页面上
 *     limit      这个板块显示多少条
 *     definition 给 AI 看的归类标准。**写得越具体，分得越准**
 *   数组顺序 = 页面上标签页的顺序（每日简报固定在最前，不在这个数组里）
 *
 * ── 怎么删一个板块 ────────────────────────────────────────────────
 *   直接从数组里删掉。原本会分到这个板块的内容，AI 会重新分到其余板块，
 *   或者判为噪音剔除。
 *
 * ── 改完要重跑吗 ─────────────────────────────────────────────────
 *   只改了 label / limit / 顺序  →  npm run render（1 秒，不花 AI 额度）
 *   改了 id / definition / 增删板块  →  npm run daily（完整重跑约 25 分钟）
 */

export interface BoardDef {
  /** 英文短名，小写字母和连字符。改这个等于换板块，历史数据对不上 */
  id: string;
  /** 页面上显示的中文名 */
  label: string;
  /** 英文模式下的名字（REPORT_LOCALE=en 时用） */
  labelEn: string;
  /** 这个板块页面上显示多少条 */
  limit: number;
  /** 给 AI 的归类标准。越具体分得越准 */
  definition: string;
}

export const BOARDS = [
  {
    id: "china-vc",
    label: "中国一级市场",
    labelEn: "China Private Markets",
    limit: 22,
    definition: `未上市公司的融资事件（各轮次）、基金募集与关账、并购与退出、IPO 申报与过会、
   创投相关政策与监管、一级市场统计数据与研究报告（清科、投中、IT桔子等机构发布）。
   以中国为主，美国等海外的重大一级市场事件（尤其是前沿科技赛道的大额融资、
   知名机构动作）也归这里。`,
  },
  {
    id: "frontier-tech",
    label: "前沿技术",
    labelEn: "Frontier Tech",
    limit: 20,
    definition: `技术本身走到哪一步了。论文与研究成果、模型能力突破、技术路线之争、benchmark 与
   评测、算法与架构创新、实验室阶段的科研进展、开源项目的技术价值。
   判断关键词：这条讲的是"能做到什么了"。`,
  },
  {
    id: "tech-business",
    label: "科技商业",
    labelEn: "Tech Business",
    limit: 20,
    definition: `前沿科技公司除技术本身之外的一切商业进展。新模型/新产品/新机器人的发布与上市、
   定价与商业模式、客户与落地案例、产能与量产、供应链、合作与联盟、人事变动、
   公司战略转向、算力采购与数据中心建设。
   判断关键词：这条讲的是"技术变成生意了"。
   与前沿技术的边界：一个新模型发布，如果重点在能力提升多少，归前沿技术；
   如果重点在发布本身、价格、可用性、谁在用，归这里。两边都沾时看行文重心。`,
  },
  {
    id: "capital-markets",
    label: "资本市场",
    labelEn: "Capital Markets",
    limit: 15,
    definition: `已上市公司与二级市场。A股/港股/美股行情与指数、上市公司财报与业绩、
   增减持与股权变动、宏观经济数据、货币与利率政策、汇率、大宗商品。`,
  },
  {
    id: "global-business",
    label: "全球商业",
    labelEn: "Global Business",
    limit: 22,
    definition: `不属于上述四类、但按《金融时报》头版标准值得放上重要版面的全球商业事件。
   大额并购与重组、行业格局重塑、巨头战略转向、重大监管处罚与反垄断、
   供应链与贸易变动、出口管制与制裁、能源与大宗商品、劳动力与人才流动、
   影响产业的地缘政治事件、跨国企业的重大经营动向、消费与零售格局变化。

   **这一栏容易产出偏少，请适当放宽**：只要是一份严肃商业报纸会放在国际版
   或商业版的内容，即使和前沿科技没有直接关系，也归这里而不是判 drop。
   判断基准是「一个关心宏观商业环境的投资人会不会想扫一眼」，而不是
   「这条是否和他的赛道直接相关」。`,
  },
] as const satisfies readonly BoardDef[];

/** 板块 id 的联合类型，供全项目做类型检查 */
export type BoardId = (typeof BOARDS)[number]["id"];

export const BOARD_IDS: BoardId[] = BOARDS.map((b) => b.id);

const BY_ID = new Map(BOARDS.map((b) => [b.id as string, b]));

export function boardLabel(id: string, locale: "zh" | "en" = "zh"): string {
  const b = BY_ID.get(id);
  if (!b) return id;
  return locale === "en" ? b.labelEn : b.label;
}

export function boardLimit(id: string): number {
  return BY_ID.get(id)?.limit ?? 15;
}

/** 拼给 AI 的板块定义清单，classify.ts 用它组装提示词 */
export function boardDefinitionsForPrompt(): string {
  return BOARDS.map(
    (b, i) => `${i + 1}. ${b.id}（${b.label}）\n   ${b.definition.trim()}`,
  ).join("\n\n");
}

/** 每日简报页面上，每条要标出所属板块，需要合法 id 清单给 AI 回填 */
export function boardIdListForPrompt(): string {
  return BOARDS.map((b) => b.id).join(" | ");
}
