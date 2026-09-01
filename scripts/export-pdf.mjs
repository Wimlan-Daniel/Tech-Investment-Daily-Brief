/**
 * 把某天的简报导出成 PDF。
 *
 *   node scripts/export-pdf.mjs            # 最新一期
 *   node scripts/export-pdf.mjs 2026-09-01 # 指定日期
 *
 * 用 Edge/Chrome 的无头模式打印。网页靠标签页切换，未激活的板块被 CSS 藏起来，
 * 直接打印只会剩当前一页——render.ts 里的 @media print 规则会在打印时把所有
 * 板块展开并加上章节标题，所以这里直接打印 HTML 即可。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = path.join(root, "每日资讯留档");
const TITLE = "前沿科技投资简报";

const BROWSERS = [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function pickDate(arg) {
  if (arg) return arg;
  const dates = fs
    .readdirSync(ARCHIVE)
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\s/)?.[1])
    .filter(Boolean)
    .sort();
  if (dates.length === 0) throw new Error(`${ARCHIVE} 里没有简报`);
  return dates[dates.length - 1];
}

const date = pickDate(process.argv[2]);
const html = path.join(ARCHIVE, `${date} ${TITLE}.html`);
const pdf = path.join(ARCHIVE, `${date} ${TITLE}.pdf`);
if (!fs.existsSync(html)) throw new Error(`找不到 ${html}`);

// 先用样本模式重渲染：关于页前置、每板块只留几条、打印时保留标签栏。
// 渲染到临时文件，不覆盖归档里的完整版网页。
const sampleHtml = path.join(ARCHIVE, `.sample-${date}.html`);
console.log("[export-pdf] 生成样本版网页…");
const render = spawnSync(
  "npx",
  ["tsx", "scripts/render.ts", date],
  {
    cwd: root,
    env: { ...process.env, SAMPLE_MODE: "true", SAMPLE_ITEMS: process.env.SAMPLE_ITEMS ?? "5" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (render.status !== 0) {
  throw new Error(`样本渲染失败：${render.stderr?.toString().slice(0, 300)}`);
}
// render.ts 会把样本版写进归档，先挪走再把完整版还原回去
fs.copyFileSync(html, sampleHtml);

const browser = BROWSERS.find((b) => fs.existsSync(b));
if (!browser) {
  throw new Error("找不到 Edge 或 Chrome —— 导出 PDF 需要其中之一");
}

const r = spawnSync(
  browser,
  [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdf}`,
    `file://${sampleHtml}`,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
if (!fs.existsSync(pdf)) {
  throw new Error(`导出失败：${r.stderr?.toString().slice(0, 300)}`);
}
fs.rmSync(sampleHtml, { force: true });

// 把归档里的网页还原成完整版（样本版只用于生成 PDF）
const restore = spawnSync("npx", ["tsx", "scripts/render.ts", date], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
});
if (restore.status !== 0) {
  console.warn("[export-pdf] 警告：完整版网页还原失败，请手动 npm run render");
}

const kb = Math.round(fs.statSync(pdf).size / 1024);
console.log(`[export-pdf] 已导出 ${pdf} （${kb} KB）`);
