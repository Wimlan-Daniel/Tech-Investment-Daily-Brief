/**
 * 把生成好的简报发布到 GitHub Pages。
 *
 *   node scripts/publish.mjs          # 发布全部历史 + 最新一期
 *   node scripts/publish.mjs --dry    # 只生成 docs/ 不推送，先看效果
 *
 * ── 为什么需要这个脚本 ───────────────────────────────────────────
 * 本项目是本地部署：简报在你自己电脑上生成，用的是 Claude 订阅额度。
 * 而 GitHub Pages 要展示网页，文件必须在仓库里。产出目录（daily_reports/
 * 与 每日资讯留档/）被 .gitignore 排除了——那是对的，里面有 JSON 中间
 * 数据和每天几百 KB 的历史，不该塞进版本管理。
 *
 * 所以这里单独准备一个 docs/ 目录：只放网页，不放中间数据。GitHub Pages
 * 可以直接指向 docs/，不需要额外的分支或工作流。
 *
 * ── 产出结构 ─────────────────────────────────────────────────────
 *   docs/index.html          最新一期（访客打开就看到今天的）
 *   docs/2026-09-01.html     按日期归档，可直接分享单期链接
 *   docs/archive.html        历史列表，倒序
 *
 * ── 隐私提醒 ─────────────────────────────────────────────────────
 * 发布 = 公开。任何人拿到网址都能看到全部内容。这些内容本身都是公开
 * 媒体的资讯摘要，不含个人信息，但请自行确认后再推送。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = path.join(root, "每日资讯留档");
const DOCS = path.join(root, "docs");
const TITLE = "前沿科技投资简报";
const dryRun = process.argv.includes("--dry");

function listReports() {
  if (!fs.existsSync(ARCHIVE)) return [];
  return fs
    .readdirSync(ARCHIVE)
    .map((f) => {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\s.+\.html$/);
      return m ? { date: m[1], file: path.join(ARCHIVE, f) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
}

const reports = listReports();
if (reports.length === 0) {
  throw new Error(`${ARCHIVE} 里没有可发布的简报，先跑 npm run daily`);
}

fs.mkdirSync(DOCS, { recursive: true });
for (const r of reports) {
  fs.copyFileSync(r.file, path.join(DOCS, `${r.date}.html`));
}
// 最新一期同时作为首页
fs.copyFileSync(reports[0].file, path.join(DOCS, "index.html"));

// 历史列表页
const rows = reports
  .map(
    (r) =>
      `      <li><a href="./${r.date}.html">${r.date}</a>${r.date === reports[0].date ? ' <span class="latest">最新</span>' : ""}</li>`,
  )
  .join("\n");
fs.writeFileSync(
  path.join(DOCS, "archive.html"),
  `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE} · 历史归档</title>
<style>
  :root { --fg:#18181b; --muted:#71717a; --rule:#e4e4e7; --link:#1d4ed8; --bg:#fafaf9; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#fafafa; --muted:#a1a1aa; --rule:#27272a; --link:#93c5fd; --bg:#0a0a0a; }
  }
  body { background:var(--bg); color:var(--fg); font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
         max-width:40rem; margin:0 auto; padding:3rem 1.5rem; line-height:1.7; }
  h1 { font-size:1.5rem; margin:0 0 0.3rem; }
  .sub { color:var(--muted); font-size:0.9rem; margin:0 0 2rem; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:0.7rem 0; border-bottom:1px solid var(--rule); }
  a { color:var(--link); text-decoration:none; font-variant-numeric:tabular-nums; }
  a:hover { text-decoration:underline; }
  .latest { color:var(--muted); font-size:0.78rem; margin-left:0.5rem; }
</style>
</head>
<body>
  <h1>${TITLE}</h1>
  <p class="sub">每日 08:00 自动生成 · 共 ${reports.length} 期</p>
  <ul>
${rows}
  </ul>
</body>
</html>
`,
  "utf8",
);

console.log(`[publish] docs/ 已生成：${reports.length} 期 + index.html + archive.html`);

if (dryRun) {
  console.log("[publish] --dry 模式，未推送。用浏览器打开 docs/index.html 预览。");
  process.exit(0);
}

// 检查有没有配置远程仓库
const remote = spawnSync("git", ["remote", "get-url", "origin"], {
  cwd: root,
  encoding: "utf8",
});
if (remote.status !== 0) {
  console.log(
    [
      "",
      "[publish] 还没有配置 GitHub 远程仓库，docs/ 已生成但未推送。",
      "",
      "在 GitHub 建好仓库后执行（把地址换成你自己的）：",
      "  git remote add origin https://github.com/你的用户名/仓库名.git",
      "  git add -A && git commit -m 'publish' && git push -u origin main",
      "",
      "然后在仓库 Settings → Pages 里把 Source 设为 main 分支的 /docs 目录。",
    ].join("\n"),
  );
  process.exit(0);
}

const add = spawnSync("git", ["add", "docs"], { cwd: root, stdio: "inherit" });
if (add.status !== 0) throw new Error("git add 失败");

const status = spawnSync("git", ["status", "--porcelain", "docs"], {
  cwd: root,
  encoding: "utf8",
});
if (!status.stdout.trim()) {
  console.log("[publish] docs/ 无变化，跳过提交");
  process.exit(0);
}

spawnSync("git", ["commit", "-m", `publish: ${reports[0].date} 简报`], {
  cwd: root,
  stdio: "inherit",
});
const push = spawnSync("git", ["push"], { cwd: root, stdio: "inherit" });
if (push.status !== 0) {
  console.warn("[publish] 推送失败——检查网络或远程仓库配置");
  process.exit(1);
}
console.log("[publish] 已推送。GitHub Pages 通常 1-2 分钟后更新。");
