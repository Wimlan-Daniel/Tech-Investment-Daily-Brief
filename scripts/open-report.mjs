#!/usr/bin/env node
/**
 * Open the latest (or specified-date) daily report HTML in a browser.
 * Cross-platform: prefers Chrome on Windows (file association often hijacked
 * by Edge), uses `open` on macOS, `xdg-open` on Linux.
 *
 * Usage:
 *   node scripts/open-report.mjs
 *   node scripts/open-report.mjs 2026-05-17
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const archiveDir = path.join(projectRoot, "每日资讯留档");
const reportsDir = path.join(projectRoot, "daily_reports");

/**
 * 优先从「每日资讯留档」里找——那是人看的归档目录，文件名带日期。
 * 找不到再回落到 daily_reports/（内部工作目录，旧数据可能只存在于那里）。
 */
function pickReport(dateArg) {
  const fromArchive = (d) =>
    path.join(archiveDir, `${d} 前沿科技投资简报.html`);
  const fromWorkdir = (d) => path.join(reportsDir, d, `${d}.html`);

  if (dateArg) {
    for (const f of [fromArchive(dateArg), fromWorkdir(dateArg)]) {
      if (fs.existsSync(f)) return f;
    }
    throw new Error(`找不到 ${dateArg} 的简报`);
  }

  const dates = new Set();
  if (fs.existsSync(archiveDir)) {
    for (const f of fs.readdirSync(archiveDir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\s/);
      if (m) dates.add(m[1]);
    }
  }
  if (fs.existsSync(reportsDir)) {
    for (const d of fs.readdirSync(reportsDir)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(fromWorkdir(d))) {
        dates.add(d);
      }
    }
  }
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  for (const d of sorted) {
    for (const f of [fromArchive(d), fromWorkdir(d)]) {
      if (fs.existsSync(f)) return f;
    }
  }
  throw new Error(
    `还没有任何简报。先跑一次 npm run daily。\n找过的目录：\n  ${archiveDir}\n  ${reportsDir}`,
  );
}

function findChromeWindows() {
  const candidates = [
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LocalAppData &&
      path.join(process.env.LocalAppData, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

/**
 * macOS 上优先使用的浏览器，按顺序尝试。
 * 想换浏览器改这个数组即可，名字要和「应用程序」文件夹里的名称一致。
 */
const PREFERRED_BROWSERS = ["Microsoft Edge", "Google Chrome"];

/** 依次尝试列表里的浏览器，全都不在就用系统默认 */
function tryOpenWith(file, candidates) {
  if (candidates.length === 0) {
    spawn("open", [file], { detached: true, stdio: "ignore" }).unref();
    console.log(`已用系统默认浏览器打开: ${file}`);
    return;
  }
  const [app, ...rest] = candidates;
  const child = spawn("open", ["-a", app, file], { stdio: "ignore" });
  child.on("error", () => tryOpenWith(file, rest));
  child.on("close", (code) => {
    if (code === 0) console.log(`已用 ${app} 打开: ${file}`);
    else tryOpenWith(file, rest);
  });
}

function openInBrowser(file) {
  const fileUrl = "file:///" + file.replace(/\\/g, "/");
  if (process.platform === "win32") {
    const chrome = findChromeWindows();
    if (chrome) {
      spawn(chrome, [fileUrl], { detached: true, stdio: "ignore" }).unref();
      console.log(`Opened in Chrome: ${file}`);
      return;
    }
    // Fall back to default association via cmd start
    console.warn("Chrome not found, using default file association.");
    spawn("cmd", ["/c", "start", "", file], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    // 依次尝试首选浏览器，都不在就交给系统默认。
    //
    // 上游只监听 spawn 的 "error" 事件来做回退，但那个事件只在 open 这个
    // 可执行文件本身找不到时才触发。指定的浏览器没装时，open 会正常启动、
    // 然后以退出码 1 结束并打印 "Unable to find application named ..."
    // ——error 事件不触发，回退永远不执行，结果是什么都没打开也没有报错。
    // 所以必须看退出码。
    tryOpenWith(file, [...PREFERRED_BROWSERS]);
    return;
  } else {
    // Linux (and any other Unix)
    spawn("xdg-open", [file], { detached: true, stdio: "ignore" }).unref();
    console.log(`Opened: ${file}`);
  }
}

try {
  const target = pickReport(process.argv[2]);
  openInBrowser(target);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
