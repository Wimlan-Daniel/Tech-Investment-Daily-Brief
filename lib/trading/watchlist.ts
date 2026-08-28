/**
 * 数据指标盯盘表。
 *
 * 服务对象是一级市场投资人，不做交易，看这些是为了读环境：
 *   - 中国市场决定境内退出窗口（科创板/创业板 IPO 节奏、港股估值水位）
 *   - 美国市场决定美元基金的募资与退出预期
 *   - 科技巨头的股价与资本开支，领先应用层融资 2-3 个季度
 *   - 汇率影响美元基金募资成本与被投企业出海结算
 *
 * 刻意不放：费城半导体等行业指数（读者反馈不关心）、加密货币、大宗商品。
 */
export type AssetGroup =
  | "cn-market" // 中国市场
  | "us-market" // 美国市场
  | "tech-giants" // 科技巨头
  | "fx"; // 汇率

export interface TickerDef {
  symbol: string; // Yahoo Finance 代码
  displayName: string; // 中文展示名
  displayNameEn?: string; // 英文展示名（缺省回落到中文）
  group: AssetGroup;
}

export function getDisplayName(t: TickerDef, locale: "zh" | "en"): string {
  return locale === "en" ? (t.displayNameEn ?? t.displayName) : t.displayName;
}

const ASSET_GROUP_LABELS_ZH: Record<AssetGroup, string> = {
  "cn-market": "中国市场",
  "us-market": "美国市场",
  "tech-giants": "科技巨头",
  fx: "汇率",
};

const ASSET_GROUP_LABELS_EN: Record<AssetGroup, string> = {
  "cn-market": "China",
  "us-market": "US",
  "tech-giants": "Tech Giants",
  fx: "FX",
};

export function getAssetGroupLabels(
  locale: "zh" | "en",
): Record<AssetGroup, string> {
  return locale === "en" ? ASSET_GROUP_LABELS_EN : ASSET_GROUP_LABELS_ZH;
}

export const ASSET_GROUP_ORDER: AssetGroup[] = [
  "cn-market",
  "us-market",
  "tech-giants",
  "fx",
];

export const WATCHLIST: TickerDef[] = [
  // === 中国市场：境内退出窗口 ===
  { symbol: "000001.SS", displayName: "上证指数", displayNameEn: "SSE Composite", group: "cn-market" },
  { symbol: "399001.SZ", displayName: "深证成指", displayNameEn: "Shenzhen Component", group: "cn-market" },
  { symbol: "000688.SS", displayName: "科创 50", displayNameEn: "STAR 50", group: "cn-market" },
  { symbol: "^HSI", displayName: "恒生指数", displayNameEn: "Hang Seng", group: "cn-market" },
  { symbol: "HSTECH.HK", displayName: "恒生科技指数", displayNameEn: "Hang Seng TECH", group: "cn-market" },
  // === 美国市场：美元基金的募资与退出预期 ===
  { symbol: "^IXIC", displayName: "纳斯达克", displayNameEn: "Nasdaq Composite", group: "us-market" },
  { symbol: "^GSPC", displayName: "标普 500", displayNameEn: "S&P 500", group: "us-market" },
  { symbol: "^DJI", displayName: "道琼斯", displayNameEn: "Dow Jones", group: "us-market" },
  // === 科技巨头：资本开支与竞争格局的先行信号 ===
  { symbol: "NVDA", displayName: "英伟达", displayNameEn: "Nvidia", group: "tech-giants" },
  { symbol: "TSM", displayName: "台积电", displayNameEn: "TSMC", group: "tech-giants" },
  { symbol: "MSFT", displayName: "微软", displayNameEn: "Microsoft", group: "tech-giants" },
  { symbol: "GOOGL", displayName: "谷歌", displayNameEn: "Alphabet", group: "tech-giants" },
  { symbol: "AAPL", displayName: "苹果", displayNameEn: "Apple", group: "tech-giants" },
  { symbol: "TSLA", displayName: "特斯拉", displayNameEn: "Tesla", group: "tech-giants" },
  { symbol: "0700.HK", displayName: "腾讯控股", displayNameEn: "Tencent", group: "tech-giants" },
  { symbol: "BABA", displayName: "阿里巴巴", displayNameEn: "Alibaba", group: "tech-giants" },
  // === 汇率：全部以人民币为基准（用户要求，美元兑日元这类交叉盘对他无意义）===
  { symbol: "USDCNY=X", displayName: "美元 / 人民币", displayNameEn: "USD / CNY", group: "fx" },
  { symbol: "JPYCNY=X", displayName: "日元 / 人民币", displayNameEn: "JPY / CNY", group: "fx" },
  { symbol: "SGDCNY=X", displayName: "新加坡元 / 人民币", displayNameEn: "SGD / CNY", group: "fx" },
];
