/* 回放与终态时序单测：验证 markJobFinished 把终态推迟到回放队列之后。
   直接内联被测逻辑的等价实现太脆弱 —— 这里从 gateway.js 里抽取函数体求值。 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "gateway.js"), "utf8");
const lines = src.split(/\r?\n/);

// 抽取需要的片段：常量 + pushAnswer/pushThinking/flushStream/waitStream
// + replayAssistantStream/markJobFinished
function extract(startMarker, endMarker, name) {
  const s = lines.findIndex((l) => l.includes(startMarker));
  const e = lines.findIndex((l, i) => i > s && l.includes(endMarker));
  if (s < 0 || e < 0) throw new Error("cannot extract " + name + " s=" + s + " e=" + e);
  return lines.slice(s, e).join("\n");
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

const code = `
${extract("const REPLAY_SPEED", "function handleSdkLine", "replay block")}
`;

// 构造一个最小 sandbox
const sandboxSrc = `
function pushAnswer(job, text) {
  job.seq = (job.seq || 0) + 1;
  job.stream.push({ seq: job.seq, kind: "answer", text, t: Date.now() });
}
function pushThinking(job, text) {
  job.seq = (job.seq || 0) + 1;
  job.stream.push({ seq: job.seq, kind: "thinking", text, t: Date.now() });
}
function flushStream(job) {
  const waiters = job.waiters || [];
  job.waiters = [];
  for (const w of waiters) { try { w(); } catch (e) {} }
}
function waitStream(job, timeoutMs) {
  const settled = ["done", "failed", "timeout"].includes(job.status);
  const settleAt = job.settledAt || job.finishedAt || 0;
  if (settled && Date.now() >= settleAt) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const fire = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(fire, timeoutMs);
    job.waiters = job.waiters || [];
    job.waiters.push(fire);
  });
}
${code}
module.exports = { replayAssistantStream, markJobFinished, pushAnswer, pushThinking, waitStream, REPLAY_MIN_GAP, REPLAY_MAX_GAP, REPLAY_SPEED };
`;
const Module = require("module");
const m = new Module(".test-replay.cjs");
m._compile(sandboxSrc, "test-replay-extracted.js");
const api = m.exports;

function newJob() {
  return {
    id: "t-test", status: "running", reply: "", error: "", events: [],
    stream: [], seq: 0, waiters: [], createdAt: Date.now(), answerPushed: false,
  };
}

// --- 用例 1：stream 为空且无 reply → 什么都不推 ---
{
  const job = newJob();
  api.replayAssistantStream(job, { stream: [] });
  check("空 stream 不产生增量", job.stream.length === 0);
  check("空 stream 不设 replayUntil", !job.replayUntil);
}

// --- 用例 2：有 text-chunks → 生成 answer 增量并设 replayUntil ---
{
  const job = newJob();
  job.reply = "hello";
  const t0 = Date.now();
  api.replayAssistantStream(job, {
    stream: [{ type: "text-chunks", dt: [10, 10, 10, 10], texts: ["h", "e", "l", "lo"] }],
  });
  check("设置了 replayUntil", job.replayUntil > t0);
  check("标记 answerPushed", job.answerPushed === true);
  check("增量尚未同步推送（排期在定时器里）", job.stream.length === 0);
  // 等回放跑完
  setTimeout(() => {
    check("回放后增量条数 = 4", job.stream.length === 4);
    check("增量 kind 均为 answer", job.stream.every((e) => e.kind === "answer"));
    check("增量文本拼接 = hello",
      job.stream.map((e) => e.text).join("") === "hello");

    // --- 用例 3：markJobFinished 推迟终态 ---
    const job2 = newJob();
    job2.reply = "abc";
    api.replayAssistantStream(job2, {
      stream: [{ type: "text-chunks", dt: [30, 30, 30], texts: ["a", "b", "c"] }],
    });
    const now = Date.now();
    api.markJobFinished(job2, "done", now);
    check("status 立即置 done（轮询可用）", job2.status === "done");
    check("settledAt 晚于 now（SSE 推迟终态）", job2.settledAt > now);
    check("settleTimer 已挂", !!job2.settleTimer);

    // --- 用例 4：reasoning + text 混合，顺序保持 ---
    const job3 = newJob();
    job3.reply = "答案";
    api.replayAssistantStream(job3, {
      stream: [
        { type: "reasoning-chunks", dt: [8, 8], texts: ["想", "一下"] },
        { type: "text-chunks", dt: [8, 8], texts: ["答", "案"] },
      ],
    });
    setTimeout(() => {
      const kinds = job3.stream.map((e) => e.kind).join(",");
      check("混合流顺序 thinking,thinking,answer,answer",
        kinds === "thinking,thinking,answer,answer");
      check("混合流文本正确",
        job3.stream.map((e) => e.text).join("") === "想一下答案");

      // --- 用例 5：dt 缺失走 MIN_GAP ---
      const job4 = newJob();
      job4.reply = "x";
      api.replayAssistantStream(job4, {
        stream: [{ type: "text-chunks", dt: [], texts: ["x"] }],
      });
      setTimeout(() => {
        check("dt 缺失仍能回放", job4.stream.length === 1);

        // --- 用例 6：只有 reasoning 无 text → 全文兜底 ---
        const job5 = newJob();
        job5.reply = "fallback";
        api.replayAssistantStream(job5, {
          stream: [{ type: "reasoning-chunks", dt: [5], texts: ["r"] }],
        });
        setTimeout(() => {
          const answers = job5.stream.filter((e) => e.kind === "answer");
          check("仅 reasoning 时兜底推全文", answers.length === 1 && answers[0].text === "fallback");

          console.log("");
          console.log("PASS " + pass + " / FAIL " + fail);
          process.exit(fail ? 1 : 0);
        }, 120);
      }, 120);
    }, 150);
  }, 150);
}
