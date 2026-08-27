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
  const { stdout } = await execFileP("curl", args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}
