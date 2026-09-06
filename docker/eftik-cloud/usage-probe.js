/**
 * cordis 外挂插件 · 任务级 token 消耗采集（零 dsh 内核改动）
 *
 * 由网关在 spawn dsh 时经 --patch 注入（name: file:///opt/gw/usage-probe.js），
 * 监听会话 `assistant/message` 持久化事件携带的 usage（provider 精确上报，
 * 非 token-meter 启发式估算），任务级累加后原子写盘到 config.outputFile；
 * 网关在任务结束时读取该文件并随 GET /task/:id 返回，供业务方（kitsume）计费。
 *
 * 字段口径（DeepSeek 官方上报，缓存单列，三段输入之和 = 计费输入）：
 *   inputTokens       未命中缓存的输入
 *   outputTokens      输出（含 reasoning）
 *   cacheReadTokens   缓存命中输入（单价约为普通输入的 1/10）
 *   cacheWriteTokens  缓存写入输入
 *   totalTokens       官方全量总计；adapter 缺省时按 input+output 推导
 *
 * 依赖的 API 面（公共契约，官方升级安全）：
 *   - cordis 插件导出 apply(ctx, config)
 *   - 会话事件 `session/event`，事件 `assistant/message` 的 data.usage?: TokenUsage
 */

module.exports = {
  apply(ctx, config) {
    const outputFile = config && config.outputFile;
    if (!outputFile) return; // 未配置输出文件则不采集

    const fs = require("fs");
    const total = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };

    // 原子写（tmp + rename）：任意时刻被杀/崩溃都不会留下半个 JSON
    const flush = () => {
      try {
        const tmp = outputFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(total));
        fs.renameSync(tmp, outputFile);
      } catch {}
    };

    ctx.on("session/event", (session, event) => {
      if (event.type !== "assistant/message") return;
      const u = event.data && event.data.usage;
      if (!u) return; // adapter 未上报（如中断步骤）则跳过
      total.calls += 1;
      total.inputTokens += u.inputTokens || 0;
      total.outputTokens += u.outputTokens || 0;
      total.totalTokens += u.totalTokens || (u.inputTokens || 0) + (u.outputTokens || 0);
      total.cacheReadTokens += u.cacheReadTokens || 0;
      total.cacheWriteTokens += u.cacheWriteTokens || 0;
      total.reasoningTokens += u.reasoningTokens || 0;
      flush();
    });
  },
};
