/**
 * 限并发地跑一批异步任务。
 *
 * 用在两个地方：抓取 42 个源、生成各板块摘要。两者原本都是严格串行——
 * 抓取串行意味着 42 次网络往返首尾相接，摘要串行意味着 8 次大模型调用
 * 排队等待。实测串行版单轮 27 分钟，其中大量时间是纯等待。
 *
 * 并发上限要按任务性质分别设定：
 *   - 网络抓取：并发高一些无妨，瓶颈在对方服务器
 *   - 大模型调用：每个并发都是一个独立的 claude 进程，超过 2 路会撞速率限制
 *     （见 lib/ai/classify.ts 的实测记录）
 *
 * 任务抛错不会中断整批——错误原样收进结果数组，由调用方决定怎么处理。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<(R | Error)[]> {
  const results: (R | Error)[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
