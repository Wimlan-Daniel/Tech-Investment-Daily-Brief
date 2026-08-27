import { spawn } from "node:child_process";
import path from "node:path";
import { classifyError, logLlmCall } from "../log";
import type { LlmRunOptions, LlmRunResult } from "../llm";

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL?.trim() || "sonnet";

function resolveCliPath(): string {
  const override = process.env.CLAUDE_CLI_PATH?.trim();
  if (override) return override;
  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, "npm", "claude.cmd");
  return "claude";
}

/**
 * Invoke the local `claude` CLI in print mode against the Max subscription.
 * Writes the user prompt over stdin to bypass shell argument length limits.
 *
 * stderr is logged as warnings but not thrown — plugins like claude-mem
 * sometimes emit non-fatal hook errors on stderr that the CLI itself
 * still completes around.
 */
export function runClaudeCli({
  systemPrompt,
  userPrompt,
  timeoutMs = 180_000,
}: LlmRunOptions): Promise<LlmRunResult> {
  const cli = resolveCliPath();
  const args = [
    "--print",
    "--model",
    CLAUDE_MODEL,
    "--append-system-prompt",
    systemPrompt,
  ];
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      // 只有 Windows 需要 shell（要靠它解析 claude.cmd）。在 macOS / Linux 上
      // 开 shell 是个陷阱：Node 会把 args 拼成一条命令字符串交给 /bin/sh，
      // **完全不做转义**。systemPrompt 里只要有换行、双引号、$、反引号、括号，
      // 就会被 shell 当成语法解析——轻则 prompt 被截断，重则引号不配对导致
      // sh 挂起等输入，最后整个调用超时。
      //
      // 实测症状：stderr 刷出一堆「/bin/sh: line N: <中文 prompt 片段>: command
      // not found」，末尾 syntax error: unexpected end of file，然后 300 秒超时。
      // 不开 shell 时参数直接传给 execve，没有任何解析，问题消失。
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const success = err === null;
      logLlmCall({
        ts: new Date(started).toISOString(),
        backend: "claude-cli",
        model: CLAUDE_MODEL,
        durationMs,
        success,
        inputChars: systemPrompt.length + userPrompt.length,
        outputChars: stdout.length,
        errorCategory: success
          ? null
          : classifyError(`${stderr}\n${err?.message ?? ""}`),
        errorSnippet:
          !success && stderr.trim() ? stderr.trim().slice(0, 200) : null,
      });
      if (err) reject(err);
      else resolve({ text: stdout.trim(), durationMs });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`claude CLI timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      if (stderr.trim()) {
        console.warn(`[claude-cli] stderr (non-fatal): ${stderr.trim()}`);
      }
      if (code !== 0 && !stdout.trim()) {
        finish(new Error(`claude CLI exited ${code} with empty stdout`));
        return;
      }
      finish(null);
    });

    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}
