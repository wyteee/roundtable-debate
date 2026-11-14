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

const LINES_EN = [
  "You ask which road to take, but what you fear is choosing wrong with nobody to catch you. Keep that fear and both roads look the same.",
  "Stop treating a reversible decision like life or death. Work out the worst case. If you can survive it, go.",
  "He makes it sound easy. The cost isn't a number, it's the person you wake up as every day for three years. I'm staying where I am.",
  "I'll give you half of that. Your worst case is real, but you missed one thing: the window won't wait while you do the math.",
];

const LINES = [
  "你嘴上问的是选哪条路，心里怕的其实是选错之后没人替你兜底。这份怕不丢掉，选哪条都一样。",
  "别把一个可以试错的决定说成生死抉择。先算清楚最坏情况你扛不扛得住，扛得住就去。",
  "他说得轻巧。代价不是数字，是你接下来三年每天醒来要面对的那个自己。我仍然站在原来那边。",
  "我收回一半。你说的最坏情况我认，但你漏了一件事：机会窗口不会等你算完账。",
];

export function mockCall(meta) {
  const { kind, charIndex = 0, round = 0, name = "嘉宾", targets = [], lang = "zh" } = meta || {};
  const en = lang === "en";
  if (kind === "frame" && en) {
    if (process.env.MOCK_FRAME === "truncated") return '{"motion": "Should you stay in the US or go home?", "a": ';
    return JSON.stringify({ motion: "Should you quit your job for a PhD?", a: "Quit for the PhD", b: "Stay put" });
  }
  if (kind === "advice" && en) return "Work out the worst case first, then decide whether you really want it.";
  if (kind === "frame") {
    // MOCK_FRAME=truncated：模拟输出被截断，用来测立题的重试和兜底
    if (process.env.MOCK_FRAME === "truncated") return '{"motion": "你该留在美国还是回国？", "a": ';
    return JSON.stringify({ motion: "你现在应该辞职去读博吗？", a: "辞职读博", b: "留在原地" });
  }
  if (kind === "advice") {
    return "先把最坏的情况想清楚，再决定你是不是真的想要它。";
  }
  // MOCK_EMPTY_SPEECH=1：第二位嘉宾开场第一次返回空正文（第二次正常），测重试
  if (process.env.MOCK_EMPTY_SPEECH === "1" && charIndex === 1 && round === 0 && !meta.attempt) {
    return JSON.stringify({ speech: "", inner_thought: "", stance: "MIXED", confidence: 3, response_type: "advance", target: null });
  }
  const SCENARIO = process.env.MOCK_SCENARIO || "settled";
  const stance = (SCRIPTS[SCENARIO] || SCRIPTS.settled)(charIndex, round);
  const speech = en
    ? `${LINES_EN[(charIndex + round) % LINES_EN.length]}`
    : `${name}：${LINES[(charIndex + round) % LINES.length]}`.slice(0, 100);
  const target = round === 0 || SCENARIO === "loop" ? null : targets[0] || null;
  return JSON.stringify({
    speech,
    inner_thought: "这一轮还算有意思。",
    stance,
    confidence: 2 + ((charIndex + round) % 4),
    change_mind: round === 0 ? (en ? "Show me you can actually afford the cost of failing" : "如果你能证明失败的代价你承担得起") : undefined,
    response_type: target ? "rebut" : "advance",
    target,
  });
}
