import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * Some sites (LinuxDo, NodeSeek, …) sit behind Cloudflare and fingerprint
 * Node's built-in fetch (undici) at the TLS layer, returning a "Just a
 * moment…" challenge page. curl's TLS signature is on Cloudflare's
 * baseline allowlist, so we shell out for those sources.
 *
 * Windows 10 1803+ ships curl in System32; Git for Windows also installs
 * one. The function will throw on absent curl — that's a deploy-time
 * config issue, not a runtime decision.
 */
export async function curlFetch(
  url: string,
  headers: Record<string, string> = {},
  timeoutSec = 20,
): Promise<string> {
  const args = ["-sSL", "-m", String(timeoutSec), "--compressed"];
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }
  args.push(url);
  try {
    const { stdout } = await execFileP("curl", args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    // execFile 抛出的 Error.message 只有一长串命令行，看不出失败原因。
    // curl 的退出码和 stderr 才是关键信息（6=DNS 解析失败、7=连不上、
    // 28=超时、35=TLS 握手失败），不带出来就没法判断是网络断了还是源挂了。
    const err = e as { code?: number; stderr?: string };
    const reason =
      (err.stderr ?? "").trim() ||
      `curl 退出码 ${err.code ?? "?"}（6=DNS失败 7=连接失败 28=超时 35=TLS失败）`;
    throw new Error(`curl 抓取失败 ${url} —— ${reason}`);
  }
}
