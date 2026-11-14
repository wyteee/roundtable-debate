// 本地调试用的假 LLM（MOCK_LLM=1 时启用）。只用来在没有 API key 的环境里
// 跑通前后端流程、验证结束标准和播放节奏，绝不用于线上。
//
// MOCK_SCENARIO:
//   settled   （默认）开场 A/B/MIXED → 第1轮 MIXED 转向 B → 之后两轮没人松口 → 分歧已清楚
//   consensus 三人很快都站到 A → 趋同提醒 → 仍然一致 → 真共识
//   loop      立场永远不变，也没人正面反驳 → 只能靠时间上限收尾

const SCRIPTS = {
  settled: (idx, round) => {
    const base = ["A", "B", "MIXED"][idx];
    if (idx === 2 && round >= 1) return "B";
    return base;
  },
  consensus: (idx, round) => (round === 0 ? ["A", "A", "MIXED"][idx] : "A"),
  loop: (idx) => ["A", "B", "MIXED"][idx],
};

const LINES = [
  "你嘴上问的是选哪条路，心里怕的其实是选错之后没人替你兜底。这份怕不丢掉，选哪条都一样。",
  "别把一个可以试错的决定说成生死抉择。先算清楚最坏情况你扛不扛得住，扛得住就去。",
  "他说得轻巧。代价不是数字，是你接下来三年每天醒来要面对的那个自己。我仍然站在原来那边。",
  "我收回一半。你说的最坏情况我认，但你漏了一件事：机会窗口不会等你算完账。",
];

export function mockCall(meta) {
  const { kind, charIndex = 0, round = 0, name = "嘉宾", targets = [] } = meta || {};
  if (kind === "frame") {
    return JSON.stringify({ motion: "你现在应该辞职去读博吗？", a: "辞职读博", b: "留在原地" });
  }
  if (kind === "advice") {
    return "先把最坏的情况想清楚，再决定你是不是真的想要它。";
  }
  const SCENARIO = process.env.MOCK_SCENARIO || "settled";
  const stance = (SCRIPTS[SCENARIO] || SCRIPTS.settled)(charIndex, round);
  const speech = `${name}：${LINES[(charIndex + round) % LINES.length]}`.slice(0, 100);
  const target = round === 0 || SCENARIO === "loop" ? null : targets[0] || null;
  return JSON.stringify({
    speech,
    inner_thought: "这一轮还算有意思。",
    stance,
    confidence: 2 + ((charIndex + round) % 4),
    change_mind: round === 0 ? "如果你能证明失败的代价你承担得起" : undefined,
    response_type: target ? "rebut" : "advance",
    target,
  });
}
