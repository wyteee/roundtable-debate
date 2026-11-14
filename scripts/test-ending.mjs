// 结束标准回归测试：用假 LLM 驱动真实的 api/debate.js，按前端的方式逐轮请求，
// 检查三种场景是否在预期的轮次触发预期的结局。
// 用法：node scripts/test-ending.mjs

import assert from "node:assert/strict";
import { evaluateEnding } from "../api/_ending.js";

process.env.MOCK_LLM = "1";

async function runScenario(name) {
  process.env.MOCK_SCENARIO = name;
  // _mock.js 每次调用时读 MOCK_SCENARIO，所以同一份 handler 可以复用
  const { default: handler } = await import("../api/debate.js");

  const call = (body) =>
    new Promise((resolve) => {
      const res = {
        code: 200,
        status(c) {
          this.code = c;
          return this;
        },
        json(d) {
          resolve({ code: this.code, data: d });
        },
      };
      handler({ method: "POST", body }, res);
    });

  const base = { question: "我该不该辞职读博", characterIds: ["nietzsche", "munger", "jobs"] };
  const { data: framed } = await call({ ...base, phase: "frame" });
  const motion = framed.motion;

  let history = [];
  let privateMemory = {};
  let nudgeRound = null;
  let nudgeNext = false;
  const log = [];
  for (let round = 0; round <= 10; round++) {
    const { code, data } = await call({ ...base, motion, phase: "debate", round, history, privateMemory, nudge: nudgeNext, nudgeRound });
    assert.equal(code, 200, JSON.stringify(data));
    if (nudgeNext) nudgeRound = round;
    nudgeNext = false;
    history = [...history, ...data.speeches.map(({ tag, shiftFrom, ...h }) => h)];
    privateMemory = data.privateMemory;
    const e = data.ending;
    log.push(`r${round} ${JSON.stringify(e.stances)} shifts=${e.shifts.length} stable=${e.stableRounds} end=${e.endType}`);
    if (e.needNudge && nudgeRound === null) nudgeNext = true;
    if (e.endType || data.hardCapped) {
      const { data: closing } = await call({ ...base, motion, phase: "closing", history });
      return { endType: e.endType, round, log, closing };
    }
  }
  return { endType: null, round: 10, log };
}

const settled = await runScenario("settled");
console.log("settled:\n  " + settled.log.join("\n  "));
assert.equal(settled.endType, "settled");
assert.equal(settled.round, 3); // r1 有人转向 → r2、r3 连续两轮不变
assert.equal(settled.closing.verdict.length, 3);
assert.deepEqual(settled.closing.verdict.find((v) => v.charId === "jobs").path, ["MIXED", "B"]);

const consensus = await runScenario("consensus");
console.log("consensus:\n  " + consensus.log.join("\n  "));
assert.equal(consensus.endType, "consensus");
assert.equal(consensus.round, 2); // r1 全员 A → r2 注入提醒 → r2 仍全员 A

const loop = await runScenario("loop");
console.log("loop:\n  " + loop.log.join("\n  "));
assert.equal(loop.endType, "looping"); // 没人正面交锋：不能判"分歧已清楚"，第3轮判绕圈
assert.equal(loop.round, 3);

// 纯函数边界：有人改立场时稳定计数清零
const h = [
  { charId: "a", round: 0, stance: "A" }, { charId: "b", round: 0, stance: "B" },
  { charId: "a", round: 1, stance: "A", responseType: "rebut", target: "b" }, { charId: "b", round: 1, stance: "A" },
];
const e = evaluateEnding({ history: h, charIds: ["a", "b"], round: 1 });
assert.equal(e.shifts.length, 1);
assert.equal(e.stableRounds, 0);
assert.equal(e.needNudge, true);

// 立题被截断：两次都解析失败 → 不报错，返回 needsEdit 让用户手填
{
  process.env.MOCK_FRAME = "truncated";
  const { default: handler } = await import("../api/debate.js");
  const longQ = "我是否应该留在美国，留在美国意味可能找不到工作并且要自费留在这里，但是回国意味着可能能找到一份工作，但是可能不喜欢而且还要加班。";
  const out = await new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(d) { resolve({ code: this.code, data: d }); } };
    handler({ method: "POST", body: { phase: "frame", question: longQ } }, res);
  });
  delete process.env.MOCK_FRAME;
  assert.equal(out.code, 200);
  assert.equal(out.data.motion.needsEdit, true);
  assert.ok(out.data.motion.motion.length <= 40);
  console.log("frame fallback:", JSON.stringify(out.data.motion));
}

console.log("\nall ending tests passed");
