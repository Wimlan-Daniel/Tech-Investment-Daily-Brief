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
  model,
}: LlmRunOptions): Promise<LlmRunResult> {
  const cli = resolveCliPath();
  const activeModel = model?.trim() || CLAUDE_MODEL;
  const args = [
    "--print",
    "--model",
    activeModel,
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
        model: activeModel,
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
      // CLI 在被限流时会以退出码 0 把 "API Error: ..." 打到 stdout，
      // 上游据此判定成功，调用方拿到的却是一段无法解析的文本。识别出来
      // 当失败处理，重试逻辑才能生效，日志里也才看得出真实原因。
      const head = stdout.trimStart().slice(0, 200);
      if (/^API Error/i.test(head)) {
        finish(new Error(`claude CLI 返回 API 错误: ${head.slice(0, 160)}`));
        return;
      }
      // 登录过期同样以退出码 0 返回一行纯文本。2026-09-02 实测：整轮 40 次
      // 调用全部在 1 秒内"成功"返回 "Failed to authenticate: OAuth session
      // expired..."，于是简报、摘要、行情全部为空，但流程一路绿灯跑完并把
      // 空报告发布到了网站。必须识别成致命错误。
      if (/^(Failed to authenticate|Not logged in|Please run \/login)/i.test(head)) {
        finish(
          new Error(
            `claude 命令行未登录或登录已过期，请在终端执行 claude auth login。原始输出: ${head.slice(0, 120)}`,
          ),
        );
        return;
      }
      finish(null);
    });

    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}
