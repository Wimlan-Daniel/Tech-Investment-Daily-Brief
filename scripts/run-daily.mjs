#!/usr/bin/env node
/**
 * Scheduler wrapper for `npm run daily`. Runs the pipeline, tees stdout+stderr
 * to logs/daily-<YYYY-MM-DD>.log, and triggers `npm run open` on success so
 * the report pops up in Chrome (on the user's interactive session).
 *
 * Returns non-zero exit code on pipeline failure so the OS scheduler marks
 * the run as errored.
 *
 * Invoked by:
 *   - Windows Task Scheduler  →  node.exe scripts\run-daily.mjs
 *   - macOS launchd            →  node scripts/run-daily.mjs
 *   - Linux cron / systemd     →  node scripts/run-daily.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Mirror deploy stdout/stderr into the daily log instead of the parent
// stdio (which the scheduler swallowed anyway). Returns the spawnSync result.
function spawnSyncShim(cmd, args, opts) {
  const r = spawnSync(cmd, args, { ...opts, stdio: "pipe", shell: true });
  const out = (r.stdout?.toString("utf8") ?? "") + (r.stderr?.toString("utf8") ?? "");
  if (out) fs.appendFileSync(logFile, out);
  return r;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
process.chdir(projectRoot);

const today = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

const now = () =>
  new Date().toTimeString().slice(0, 8); // HH:MM:SS

const logDir = path.join(projectRoot, "logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `daily-${today}.log`);

// ── 两道闸门 ────────────────────────────────────────────────────
// 定时任务除了每天 08:00 的准点触发，还挂了一个每 30 分钟的 StartInterval
// 作为补跑网（见 scripts/install.mjs）。launchd 会把睡眠期间错过的间隔触发
// 在**机器醒来时立刻**补上，所以合盖一上午、中午掀开盖子几秒内就会跑起来。
//
// 代价是一天要触发约 48 次，绝大多数应该什么都不做。两道闸门：
//
//   闸门一：今天的报告已存在 → 退出。
//     判断依据是 HTML 在不在——daily.ts 在简报为空且零摘要时会拒绝写文件，
//     所以「有 HTML」正好等于「这轮真的成了」，失败的轮次不会挡住补跑。
//
//   闸门二：现在还没到计划时刻 → 退出。
//     少了这道，半夜 0 点掀一下盖子就会生成一份几乎没有当天新闻的简报，
//     而且因为闸门一，早上 8 点那次反而会被挡掉。
//
// 两种跳过都不写日志：一天 47 次「已跳过」会把日志淹掉，而日志是用来查
// 「哪一轮跑了、结果如何」的。要确认今天跑没跑，看 daily_reports/<日期>/ 即可。
const force = process.argv.includes("--force");
const todayHtml = path.join(projectRoot, "daily_reports", today, `${today}.html`);
if (!force && fs.existsSync(todayHtml)) process.exit(0);

const earliestHour = Number(process.env.DAILY_BRIEF_EARLIEST_HOUR ?? 8);
if (!force && Number.isFinite(earliestHour) && new Date().getHours() < earliestHour) {
  process.exit(0);
}

fs.appendFileSync(logFile, `[${now()}] running npm run daily\n`);

// `shell: true` lets us write 'npm' instead of resolving npm.cmd vs npm
// across platforms. The downside (shell injection) is not a concern here
// since we're not passing user-controlled args.
// 用 caffeinate 包住整轮：macOS 定时任务把机器从睡眠唤醒后，若无电源断言
// 会很快回到 DarkWake/Sleep 循环，网络随之中断。2026-08-31 实测：08:03 启动，
// 前 15 个源正常，之后连续 27 个源全部 curl 失败，而同样的地址手动测全部 200。
//   -i 阻止空闲睡眠  -m 阻止磁盘休眠  -s 阻止系统睡眠（**仅接电源时生效**）
//   -u 声明「用户处于活跃状态」
//
// 2026-09-04 补上 -u。那天早上机器用电池深睡眠，08:14 被定时器叫成 DarkWake，
// 任务刚起来机器就睡回去了。-i/-m 只挡空闲睡眠，-s 在电池上根本不生效，
// 三个加起来都拉不住一次 DarkWake。-u 会把 DarkWake 提升成完整唤醒，
// 这是电池供电下唯一可靠的办法。
// 副作用：屏幕会亮（合盖时无影响）。跑完断言自动释放。
const child = spawn("caffeinate", ["-imsu", "npm", "run", "daily"], {
  cwd: projectRoot,
  shell: true,
  stdio: ["ignore", "pipe", "pipe"],
});

const logStream = fs.createWriteStream(logFile, { flags: "a" });
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

child.on("close", (code) => {
  if (code === 0) {
    fs.appendFileSync(logFile, `\n[${now()}] OK\n`);

    // Deploy to remote host (no-op if DEPLOY_HOST not set in .env.local).
    // Runs synchronously so the log captures the outcome, but a failure
    // here is non-fatal — daily.html is on disk, the user can rerun
    // `npm run deploy` later.
    fs.appendFileSync(logFile, `[${now()}] deploying…\n`);
    const deployResult = spawnSyncShim("node", ["scripts/deploy.mjs"], {
      cwd: projectRoot,
    });
    if (deployResult.status === 0) {
      fs.appendFileSync(logFile, `[${now()}] deploy OK\n`);
    } else {
      fs.appendFileSync(
        logFile,
        `[${now()}] deploy FAILED (exit ${deployResult.status}) — non-fatal, run \`npm run deploy\` to retry\n`,
      );
    }

    // Detached so we don't block on Chrome's lifetime. Errors here are
    // cosmetic — the report exists on disk regardless.
    // 发布到 GitHub Pages。没配远程仓库时只生成 docs/ 不推送，
    // 所以本地部署阶段加着也无害。
    spawnSyncShim("node", ["scripts/publish.mjs"], { cwd: projectRoot });

    const opener = spawn("npm", ["run", "open"], {
      cwd: projectRoot,
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    opener.unref();
    process.exit(0);
  } else {
    fs.appendFileSync(logFile, `\n[${now()}] FAILED: npm run daily exited ${code}\n`);
    process.exit(1);
  }
});

child.on("error", (err) => {
  fs.appendFileSync(logFile, `\n[${now()}] FAILED to spawn: ${err.message}\n`);
  process.exit(1);
});
