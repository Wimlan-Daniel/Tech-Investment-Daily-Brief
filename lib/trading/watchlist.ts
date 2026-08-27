/**
 * 一级市场视角的二级市场参照盘。
 *
 * 一级市场投资人不炒股，但二级市场是三件事的先行指标：
 *   1. 退出环境 —— 科技股估值决定 IPO 窗口开不开、并购方肯不肯出价
 *   2. 技术风向 —— 半导体和算力龙头的资本开支，领先应用层融资 2-3 个季度
 *   3. 估值锚   —— 无风险利率是一级市场折现率的地板；汇率影响美元基金募资
 *
 * 所以这里只留 7 个标的，全部是"读环境"用的，没有个股交易标的。
 */
export type AssetGroup =
  | "exit-window" // 退出环境
  | "tech-signal" // 技术风向
  | "valuation-anchor"; // 估值锚

export interface TickerDef {
  symbol: string; // Yahoo Finance 代码
  displayName: string; // 中文展示名
  displayNameEn?: string; // 英文展示名（缺省时回落到中文）
  group: AssetGroup;
}

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "exit-window": "退出环境",
  "tech-signal": "技术风向",
  "valuation-anchor": "估值锚",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "exit-window": "Exit Window",
  "tech-signal": "Tech Signal",
  "valuation-anchor": "Valuation Anchor",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

export const ASSET_GROUP_ORDER: AssetGroup[] = [
  "exit-window",
  "tech-signal",
  "valuation-anchor",
];

export const WATCHLIST: TickerDef[] = [
  // === 退出环境：三个主要退出市场的估值水位 ===
  { symbol: "^IXIC", displayName: "纳斯达克", displayNameEn: "Nasdaq Composite", group: "exit-window" },
  { symbol: "HSTECH.HK", displayName: "恒生科技指数", displayNameEn: "Hang Seng TECH", group: "exit-window" },
  { symbol: "000688.SS", displayName: "科创 50", displayNameEn: "STAR 50", group: "exit-window" },
  // === 技术风向：算力链条的景气度 ===
  { symbol: "^SOX", displayName: "费城半导体指数", displayNameEn: "PHLX Semiconductor", group: "tech-signal" },
  { symbol: "NVDA", displayName: "英伟达", displayNameEn: "Nvidia", group: "tech-signal" },
  // === 估值锚：折现率与汇率 ===
  { symbol: "^TNX", displayName: "10Y 美债收益率 (%)", displayNameEn: "10Y Treasury Yield (%)", group: "valuation-anchor" },
  { symbol: "USDCNY=X", displayName: "美元 / 人民币", displayNameEn: "USD / CNY", group: "valuation-anchor" },
];
