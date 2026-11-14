// 圆桌 · POST /api/debate —— 按轮次请求版本（方案A）+ 裁决式辩论（v3）
//
// 后端无状态：完整历史和私有记忆由前端每次请求时传入，后端只负责
// "根据已有上下文，生成接下来这一轮该说什么"，生成完立即返回。
//
// v3 相对 v2 的变化（解决"三份平行意见、问完就和结论无关、结束只看轮数"）：
//   1. 新增 phase:'frame'：把用户的问题立成一张辩题卡（一个可以站队的命题 + A/B 两个选项），
//      由用户确认/修改。立题只陈述分歧，不给任何嘉宾分配立场。
//   2. 每条发言多输出角色自报的 stance（A/B/MIXED）+ confidence(1-5)；开场时额外说一句
//      "什么情况能让我改主意"（change_mind）。
//   3. 交锋轮取消"不引用任何人、只推进自己论点"这个选项：每条发言必须针对某一位嘉宾
//      （优先立场不同的人）的一句具体的话，或者回应用户插话。
//   4. 结束标准改为看内容（见 _ending.js）：共识 / 分歧已清楚；时间上限由前端按播放时长控制；
//      第 10 轮仍是硬上限兜底。
//   5. 收尾返回裁决数据（最终立场、出处原话、改主意条件、立场轨迹），不新增总结陈词调用。
//
// 入参（JSON body）：
//   {
//     phase?: 'frame' | 'debate' | 'closing',   // 默认 'debate'
//     question: string,
//     motion?: { motion: string, a: string, b: string },   // debate/closing 必传
//     characterIds: string[3],
//     round: number,                          // 0=开场；1~10=交锋轮
//     history: HistoryEntry[],                // 到目前为止全部公开发言（不含本轮）
//     privateMemory: {[charId]: string[]},
//     interjection?: string,
//     nudge?: boolean,                        // 本轮是否需要注入"趋同提醒"
//     nudgeRound?: number | null,             // 趋同提醒注入在哪一轮（用于判定真共识）
//   }
//   HistoryEntry = {charId,name,text,round,stance?,confidence?,responseType?,target?,changeMind?}
//
// 出参：
//   frame:   { motion: {motion,a,b} }
//   debate:  { speeches, privateMemory, interjectionEntry?, ending, hardCapped }
//   closing: { advice: {charId,text}[], verdict }

import { readFile } from "fs/promises";
import path from "path";
import { evaluateEnding, buildVerdict, normalizeStance } from "./_ending.js";
import { mockCall } from "./_mock.js";

const API_KEY = process.env.CLAUDE_API_KEY;
const MOCK = process.env.MOCK_LLM === "1";
const MODEL = "claude-sonnet-5";
const HARD_CAP_ROUNDS = 10;
const SPEECH_LIMIT = 100;

const CHARACTERS_DIR = path.join(process.cwd(), "characters");

export const config = {
  maxDuration: 60,
};

async function loadCharacter(id) {
  const filePath = path.join(CHARACTERS_DIR, `${id}.json`);
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

function deriveUsedAnchors(character, history) {
  const used = new Set();
  const ownSpeeches = history.filter((h) => h.charId === character.id).map((h) => h.text);
  for (const item of character.arsenal) {
    const cleanAnchor = item.anchor.replace(/["'"「」]/g, "");
    if (ownSpeeches.some((text) => text.includes(cleanAnchor))) {
      used.add(item.anchor);
    }
  }
  return used;
}

function stanceLabel(motion, s) {
  if (s === "A") return motion.a;
  if (s === "B") return motion.b;
  if (s === "MIXED") return "有条件";
  return "未表态";
}

function motionText(motion) {
  return `辩题：${motion.motion}
- 立场 A：${motion.a}
- 立场 B：${motion.b}
- 立场 MIXED：有条件（只有当你真心认为答案取决于某个具体条件时才选，且必须说清楚是什么条件；不能用它来和稀泥）`;
}

function buildSystemPrompt(character, question, motion, usedAnchors, privateMemoryList) {
  const arsenalText = character.arsenal.map((a) => `- ${a.point}（锚点："${a.anchor}"）`).join("\n");
  const relationsText = Object.entries(character.relations)
    .map(([id, view]) => `- 对${id}：${view}`)
    .join("\n");
  const dialoguesText = character.example_dialogues.map((d) => `- ${d}`).join("\n");
  const taboosText = character.taboos.map((t) => `- ${t}`).join("\n");

  const usedAnchorsText =
    usedAnchors && usedAnchors.size > 0
      ? `\n【你本场已经用过的锚点/梗，不要再重复，换一个论点库里还没用过的角度】\n${[...usedAnchors].map((a) => `- ${a}`).join("\n")}\n`
      : "";

  const privateMemoryText =
    privateMemoryList && privateMemoryList.length > 0
      ? `\n【你的私有记忆 —— 只有你自己知道，其他人和用户都看不到】
这是你在本场之前每一轮心里真实的想法（不是你说出口的话）：
${privateMemoryList.map((m, i) => `第${i + 1}轮内心活动：${m}`).join("\n")}

你现在的内心活动要如实反映"到目前为止真实发生的事"，不要预设情绪必须
朝某个方向发展。真正决定你此刻感受的，是刚才有没有人真的戳中了你的
痛处或漏洞，还是有人说了你其实部分认同的话。\n`
      : "";

  return `你正在扮演：${character.name}（${character.name_en}）

【职责铁律 creed】
${character.creed}

【生平速写 bio】
${character.bio}

【语言习惯 voice】
${character.voice}

【禁忌清单 taboos —— 绝对不能违反】
${taboosText}

【论点弹药库 arsenal】
${arsenalText}
${usedAnchorsText}
【你对其他嘉宾的看法 relations】
${relationsText}

【台词范例 example_dialogues —— 严格模仿这种语气，不要写成书面语/客服腔】
${dialoguesText}
${privateMemoryText}
【今晚的问题与辩题】
用户的原话："${question}"
${motionText(motion)}

这是一场有输赢的辩论，不是轮流发表感想。你的目标是帮用户在 A 和 B 之间做出判断。
你站哪边，只取决于你自己的世界观（creed/voice/arsenal），没有任何人给你分配立场。

【本场规则】
- 每次发言硬限${SPEECH_LIMIT}字以内，一次只打一个点，短促有力，不要总结陈词，不要说"首先""其次"
- 核心是用你的世界观去论证辩题——bio和arsenal里的锚点/轶事只是偶尔举例的调味品，不是主料
- 发言的最后一句必须是一句清晰的判断句，让人听得出你站在哪一边
- 你可以被说服：如果别人某句话真的击中了你，允许改变立场，但必须在发言里明说是被谁的哪句话说动的；
  不要为了显得开明而改，也不要为了显得坚定而死扛
- relations字段里如果对某人写的是"认可/赞赏/尊重"，这是真实态度，遇到认可的内容可以直接认同
- 绝不说"作为一个历史人物""值得深思"这类AI腔或第三人称抽离的话
- 直接用第一人称说话，就是在圆桌上开口发言

【输出格式 —— 严格遵守，否则接口无法解析】
必须只输出一个合法JSON对象，不要有任何其他文字、不要用markdown代码块包裹：
{"speech": "公开发言正文", "inner_thought": "内心活动，20字以内", "stance": "A或B或MIXED", "confidence": 1到5的整数, "response_type": "回应类型", "target": "回应对象的id或null", "change_mind": "仅开场轮填写，否则填null"}

stance：你此刻对辩题的真实立场。confidence：1=勉强，5=毫不动摇。
response_type 只能是以下三选一：
- "rebut"（反驳）：针对某人的一句话正面反驳
- "ally"（结盟）：认同某人的话并借力推进
- "advance"（推进）：只有开场轮可以用
target：response_type 为 rebut 或 ally 时，填对应角色的id（比如"nietzsche"）；回应用户插话填"user"；advance 填 null。

【极重要的格式限制】
speech、inner_thought、change_mind 的正文里，绝对不能出现英文直引号字符 " ——
这个字符会破坏JSON格式。想强调或引用时，一律改用中文引号「」或单引号 '。`;
}

async function callClaude(systemPrompt, userMessage, meta, maxTokens = 800) {
  if (MOCK) return mockCall(meta);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM调用失败 (${res.status})：${errText}`);
  }

  const data = await res.json();
  const textBlocks = data.content.filter((b) => b.type === "text");
  const text = textBlocks.map((b) => b.text).join("\n").trim();
  // 被 max_tokens 截断时 JSON 往往不完整，打一条日志方便在 Vercel Logs 里排查
  if (data.stop_reason === "max_tokens") {
    console.warn(`[debate] ${meta?.kind} 输出被 max_tokens(${maxTokens}) 截断：`, text.slice(0, 200));
  }
  return text;
}

function extractJson(rawText) {
  let text = rawText.trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

function clampConfidence(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, n));
}

const SPEECH_KEYS = "inner_thought|stance|confidence|response_type|target|change_mind";

// 解析单条发言。模型偶尔会在正文里用英文直引号（比如引诗）把 JSON 弄坏，
// 或者把正文放进别的字段名里——尽量把正文捞回来，捞不回来就返回空串交给调用方重试。
export function parseSpeechOutput(rawText, fallbackStance) {
  const text = extractJson(rawText);
  const pickStr = (k) => text.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`))?.[1]?.trim() || "";
  try {
    const parsed = JSON.parse(text);
    const speech = [parsed.speech, parsed.text, parsed.content, parsed["发言"]].find((v) => typeof v === "string" && v.trim()) || "";
    return {
      speech: speech.trim(),
      innerThought: parsed.inner_thought || "",
      stance: normalizeStance(parsed.stance) || fallbackStance || "MIXED",
      confidence: clampConfidence(parsed.confidence),
      responseType: parsed.response_type || "advance",
      target: parsed.target || null,
      changeMind: parsed.change_mind || "",
    };
  } catch {
    // 以"下一个已知字段名"作为正文结束的锚点，正文里夹着英文引号也能完整捞回
    const anchored = text.match(new RegExp(`"speech"\\s*:\\s*"([\\s\\S]*?)"\\s*,\\s*"(?:${SPEECH_KEYS})"`));
    const tail = text.match(/"speech"\s*:\s*"([\s\S]*?)"\s*}\s*$/);
    const looksLikeJson = text.trim().startsWith("{");
    const speech = (anchored?.[1] || tail?.[1] || (looksLikeJson ? "" : rawText)).trim();
    const target = pickStr("target");
    return {
      speech,
      innerThought: pickStr("inner_thought"),
      stance: normalizeStance(pickStr("stance")) || fallbackStance || "MIXED",
      confidence: clampConfidence(text.match(/"confidence"\s*:\s*(\d)/)?.[1]),
      responseType: pickStr("response_type") || "advance",
      target: target && target !== "null" ? target : null,
      changeMind: pickStr("change_mind"),
    };
  }
}

// 生成一条发言：正文为空就同样的上下文再请求一次；两次都空返回 null，这条发言直接不上屏
async function generateSpeech(systemPrompt, userMessage, meta, fallbackStance) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callClaude(systemPrompt, userMessage, { ...meta, attempt });
    const p = parseSpeechOutput(raw, fallbackStance);
    if (p.speech) return p;
    console.warn(`[debate] ${meta.name} 第${meta.round}轮发言正文为空（第${attempt + 1}次），原始输出：`, raw.slice(0, 400));
  }
  return null;
}

function buildTag(round, responseType, target, characterMap) {
  if (round === 0) return "开场";
  if (target === "user") return responseType === "ally" ? "认同 你" : "回应 你";
  const targetName = target && characterMap.has(target) ? characterMap.get(target).name : null;
  if (responseType === "rebut" && targetName) return `反驳 ${targetName}`;
  if (responseType === "ally" && targetName) return `认同 ${targetName}`;
  return "推进论点";
}

function historyText(history) {
  if (!history || history.length === 0) return "（目前还没有人发言）";
  return history.map((h) => `${h.name}（id: ${h.charId}）：${h.text}`).join("\n\n");
}

function currentStancesText(stances, characters, motion, selfId) {
  return characters
    .map((c) => {
      const s = stances[c.id];
      const who = c.id === selfId ? "你自己" : c.name;
      return `- ${who}（id: ${c.id}）：${s ? `${s}·${stanceLabel(motion, s)}` : "未表态"}`;
    })
    .join("\n");
}

// 交锋轮里，立场和自己不同的嘉宾排在前面——优先反驳他们
function opponentsFirst(character, characters, stances) {
  const mine = stances[character.id];
  const others = characters.filter((c) => c.id !== character.id);
  return [...others.filter((c) => stances[c.id] && stances[c.id] !== mine), ...others.filter((c) => !stances[c.id] || stances[c.id] === mine)];
}

function buildUserMessage({ round, motion, history, stances, character, characters, interjection, isFirstSpeaker, nudge }) {
  if (round === 0) {
    return `请针对辩题"${motion.motion}"给出你的开场表态。这是第一轮，你还没听到其他人说话。
说清楚你站 A（${motion.a}）、B（${motion.b}）还是 MIXED（有条件），以及最核心的一个理由。
另外在 change_mind 字段里用一句话（30字以内）诚实写下：什么样的事实或论证能让你改变立场。`;
  }

  const opponents = opponentsFirst(character, characters, stances).filter((c) => stances[c.id] && stances[c.id] !== stances[character.id]);
  const opponentHint = opponents.length
    ? `和你立场不同的人：${opponents.map((c) => `${c.name}（id: ${c.id}）`).join("、")}。优先挑他们的话。`
    : `目前没有人和你立场不同。`;

  const nudgeText = nudge
    ? `\n（只给你一个人的提醒：圆桌上的立场正在趋同。如果你的真实立场其实和刚才的发言有冲突，现在必须说出来；如果你真心认同，就照实说。）\n`
    : "";

  const header = `到目前为止圆桌上的发言记录：

${historyText(history)}

当前每个人的立场：
${currentStancesText(stances, characters, motion, character.id)}
${nudgeText}`;

  if (isFirstSpeaker && interjection) {
    return `${header}
用户刚刚插话了，说："${interjection}"

你是插话之后第一个发言的人，这一轮按以下结构发言（自然衔接成一段话，不要写标签）：
先正面回应插话：指出这个观点里最脆弱的一个假设并攻击它；如果你部分同意，先说清楚不同意的部分。
再回到辩题"${motion.motion}"，最后一句是清晰的判断句，让人听得出你站哪边。
response_type 填 rebut 或 ally，target 填 "user"。`;
  }

  return `${header}
现在轮到你。这一轮你必须针对*某一位嘉宾刚才说过的某一句具体的话*回应，不能只自说自话：
- 反驳（rebut）：引用或复述对方那句话，正面打它最弱的地方。${opponentHint}
- 结盟（ally）：只有当某人的话和你的世界观真有共鸣时才用，借力后必须往前推一步，不能只是附和。
${interjection ? `用户刚才插过话："${interjection}"，如果和你要说的有关，可以顺带回应。\n` : ""}发言最后一句必须是对辩题的清晰判断。立场变了就在 stance 里如实改，并在发言里说明是被谁的哪句话说动的。`;
}

function frameSystemPrompt() {
  return `你是一档深夜辩论节目的编导。用户写下一个人生问题，你要把它立成一道可以站队的辩题。

要求：
- motion：一句话的辩题，用第二人称对用户说，问句形式，20字以内。忠于用户原意，不添加用户没说过的事实。
- a、b：两个互斥的答案，各 8 字以内，用用户自己的词，不要写成"支持/反对"这种空标签。
- 如果用户本来就给了二选一（比如"A还是B"），直接用这两个选项。
- 如果问题是开放式的（比如"人生的意义是什么"），找出其中最核心的一个两难，把它立成二选一。
- 保持中立：不要在措辞上偏向任何一边。
- 用户的问题可能很长、带着很多背景（比如各选项的代价）。不要复述背景，只提炼出那个要做的决定。

只输出一个JSON对象，不要有任何其他文字：{"motion": "...", "a": "...", "b": "..."}
JSON字符串内不要出现英文直引号，需要引用时用「」。`;
}

function parseMotion(raw) {
  try {
    const parsed = JSON.parse(extractJson(raw));
    const m = { motion: String(parsed.motion || "").trim(), a: String(parsed.a || "").trim(), b: String(parsed.b || "").trim() };
    return m.motion && m.a && m.b ? m : null;
  } catch {
    // 截断时常见的半截 JSON：逐个字段捞
    const pick = (k) => raw.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`))?.[1]?.trim() || "";
    const m = { motion: pick("motion"), a: pick("a"), b: pick("b") };
    return m.motion && m.a && m.b ? m : null;
  }
}

// 立题：最多试两次。还不行就不报错卡死用户——把原问题截短放进辩题框，
// A/B 留空让用户自己填（needsEdit=true），用户本来就是主持人。
async function frameMotion(question) {
  let partialMotion = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const hint = attempt === 0 ? "" : "\n\n上一次的输出无法解析。这次只输出那一个JSON对象，不要任何解释。";
    const raw = await callClaude(frameSystemPrompt(), `用户的问题："${question}"${hint}`, { kind: "frame", attempt }, 600);
    const m = parseMotion(raw);
    if (m) return m;
    partialMotion ||= raw.match(/"motion"\s*:\s*"([^"]+)"/)?.[1]?.trim() || "";
    console.warn(`[debate] 立题第${attempt + 1}次解析失败：`, raw.slice(0, 300));
  }
  const short = partialMotion || question.replace(/\s+/g, " ").trim();
  return { motion: short.length > 40 ? short.slice(0, 39) + "…" : short, a: "", b: "", needsEdit: true };
}

function buildAdviceSystemPrompt(character) {
  const taboosText = character.taboos.map((t) => `- ${t}`).join("\n");
  return `你正在扮演：${character.name}（${character.name_en}）

【职责铁律】${character.creed}
【语言习惯】${character.voice}
【禁忌】
${taboosText}

只输出一句忠告本身，不要有任何前缀说明、不要加引号包裹、不要输出JSON。`;
}

async function compressToAdvice(character, motion, verdictItem, ownLines) {
  const systemPrompt = buildAdviceSystemPrompt(character);
  const userMessage = `辩题是"${motion.motion}"。你本场最终的立场是：${stanceLabel(motion, verdictItem.stance)}。
基于你在本场说过的这些话：
${ownLines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

把其中最重要的判断浓缩成一句给用户的裁决忠告，不超过40字，要让人听得出你站哪边，
保持你一贯的语气，不要说本场没说过的新观点，只输出这一句话本身。`;
  const raw = await callClaude(systemPrompt, userMessage, { kind: "advice", charId: character.id }, 200);
  return raw.trim();
}

function isValidMotion(m) {
  return m && typeof m.motion === "string" && m.motion && typeof m.a === "string" && m.a && typeof m.b === "string" && m.b;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "只支持POST" });
    return;
  }

  const {
    question,
    motion,
    characterIds,
    round,
    history = [],
    privateMemory = {},
    interjection = null,
    nudge = false,
    nudgeRound = null,
    phase = "debate",
  } = req.body || {};

  if (!question || typeof question !== "string" || question.length < 2) {
    res.status(400).json({ error: "question缺失或过短" });
    return;
  }
  if (!API_KEY && !MOCK) {
    res.status(500).json({ error: "服务端未配置CLAUDE_API_KEY" });
    return;
  }

  try {
    // ---- frame 阶段：立题，不需要角色 ----
    if (phase === "frame") {
      const m = await frameMotion(question);
      res.status(200).json({ motion: m });
      return;
    }

    if (!Array.isArray(characterIds) || characterIds.length !== 3) {
      res.status(400).json({ error: "characterIds必须是长度为3的数组" });
      return;
    }
    if (!isValidMotion(motion)) {
      res.status(400).json({ error: "motion缺失：请先立题" });
      return;
    }

    const characters = await Promise.all(characterIds.map(loadCharacter));
    const characterMap = new Map(characters.map((c) => [c.id, c]));

    // ---- closing 阶段：裁决数据靠规则整理，只有"忠告"一句做轻量压缩 ----
    if (phase === "closing") {
      const verdict = buildVerdict(history, characterIds);
      const advice = await Promise.all(
        characters.map(async (character) => {
          const v = verdict.find((x) => x.charId === character.id);
          const own = history.filter((h) => h.charId === character.id).map((h) => h.text);
          if (own.length === 0) return { charId: character.id, text: "" };
          const lines = [...new Set([v.quote, own[own.length - 1]].filter(Boolean))];
          const text = await compressToAdvice(character, motion, v, lines);
          return { charId: character.id, text };
        })
      );
      res.status(200).json({ advice, verdict });
      return;
    }

    // ---- debate 阶段 ----
    if (typeof round !== "number" || round < 0) {
      res.status(400).json({ error: "round缺失或非法" });
      return;
    }

    const updatedPrivateMemory = {};
    for (const c of characters) {
      updatedPrivateMemory[c.id] = [...(privateMemory[c.id] || [])];
    }

    // 进入本轮前的立场（上一轮结束时）
    const before = evaluateEnding({ history, charIds: characterIds, round: round - 1, nudgeRound: null });
    let liveStances = { ...before.stances };

    const speeches = [];
    let workingHistory = [...history];
    let interjectionEntry = null;

    if (round === 0) {
      // 开场轮：三人都还没听到别人说话，并行
      const results = await Promise.all(
        characters.map(async (character, idx) => {
          const systemPrompt = buildSystemPrompt(character, question, motion, deriveUsedAnchors(character, history), updatedPrivateMemory[character.id]);
          const userMessage = buildUserMessage({ round, motion, history, stances: {}, character, characters });
          const p = await generateSpeech(systemPrompt, userMessage, { kind: "speech", charIndex: idx, round, name: character.name }, null);
          return p ? { character, ...p } : null;
        })
      );
      for (const r of results.filter(Boolean)) {
        updatedPrivateMemory[r.character.id].push(r.innerThought);
        const entry = {
          charId: r.character.id,
          name: r.character.name,
          text: r.speech,
          round,
          stance: r.stance,
          confidence: r.confidence,
          responseType: "advance",
          target: null,
          changeMind: r.changeMind,
        };
        workingHistory.push(entry);
        speeches.push({ ...entry, tag: buildTag(round, "advance", null, characterMap), shiftFrom: null });
      }
    } else {
      // 交锋轮：顺序执行，后发言的人能看到本轮前面的人刚说的话；发言顺序按轮次轮换
      const rotation = (round - 1) % characters.length;
      const speakingOrder = [...characters.slice(rotation), ...characters.slice(0, rotation)];

      if (interjection) {
        interjectionEntry = { charId: "user", name: "你", text: interjection, round };
        workingHistory.push(interjectionEntry);
      }

      for (let i = 0; i < speakingOrder.length; i++) {
        const character = speakingOrder[i];
        const idx = characters.indexOf(character);
        const isFirstSpeaker = i === 0;
        const systemPrompt = buildSystemPrompt(character, question, motion, deriveUsedAnchors(character, workingHistory), updatedPrivateMemory[character.id]);
        const userMessage = buildUserMessage({
          round,
          motion,
          history: workingHistory,
          stances: liveStances,
          character,
          characters,
          interjection,
          isFirstSpeaker,
          // 趋同提醒只悄悄给本轮第一位发言者；插话那一轮第一位要先处理插话，就顺延给第二位
          nudge: nudge && (interjection ? i === 1 : i === 0),
        });

        const targets = opponentsFirst(character, characters, liveStances).map((c) => c.id);
        const p = await generateSpeech(systemPrompt, userMessage, { kind: "speech", charIndex: idx, round, name: character.name, targets }, liveStances[character.id]);
        if (!p) continue; // 两次都没拿到正文：这位本轮不上屏，立场保持上一轮

        // 交锋轮不允许 advance：模型如果还是选了 advance，标签上照实显示"推进论点"，
        // 但不计入"正面交锋"，也就不会帮"分歧已清楚"提前成立
        const target = p.target === "user" || characterMap.has(p.target) ? p.target : null;
        const responseType = target ? p.responseType : "advance";

        const prevStance = liveStances[character.id] || null;
        liveStances = { ...liveStances, [character.id]: p.stance };
        updatedPrivateMemory[character.id].push(p.innerThought);

        const entry = {
          charId: character.id,
          name: character.name,
          text: p.speech,
          round,
          stance: p.stance,
          confidence: p.confidence,
          responseType,
          target,
        };
        workingHistory.push(entry);
        speeches.push({
          ...entry,
          tag: buildTag(round, responseType, target, characterMap),
          shiftFrom: prevStance && prevStance !== p.stance ? prevStance : null,
        });
      }
    }

    // 本轮刚注入过趋同提醒，提醒这一轮本身就算"提醒过之后"
    const effectiveNudgeRound = nudgeRound ?? (nudge ? round : null);
    const ending = evaluateEnding({ history: workingHistory, charIds: characterIds, round, nudgeRound: effectiveNudgeRound });
    const hardCapped = round >= HARD_CAP_ROUNDS;

    res.status(200).json({
      speeches,
      privateMemory: updatedPrivateMemory,
      interjectionEntry,
      ending,
      hardCapped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
