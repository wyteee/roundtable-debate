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
//     lang?: 'zh' | 'en',                       // 默认 'zh'：决定人物卡、提示词和辩论语言
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
import { getPrompts, opponentsFirst, LANGS } from "./_prompts.js";

const API_KEY = process.env.CLAUDE_API_KEY;
const MOCK = process.env.MOCK_LLM === "1";
const MODEL = "claude-sonnet-5";
const HARD_CAP_ROUNDS = 10;

const CHARACTERS_DIR = path.join(process.cwd(), "characters");

export const config = {
  maxDuration: 60,
};

// 中文人物卡在 characters/*.json，英文人物卡在 characters/en/*.json（同一套字段，英文重写）
async function loadCharacter(id, lang) {
  if (!/^[a-z_]+$/.test(id)) throw new Error(`非法的角色id：${id}`);
  const filePath = lang === "en" ? path.join(CHARACTERS_DIR, "en", `${id}.json`) : path.join(CHARACTERS_DIR, `${id}.json`);
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

function deriveUsedAnchors(character, history) {
  const used = new Set();
  // 去掉引号、统一大小写再比较，中英文锚点都适用（英文锚点里常有 don't 这类撇号）
  const norm = (t) => t.replace(/["'“”‘’「」『』]/g, "").toLowerCase();
  const ownSpeeches = history.filter((h) => h.charId === character.id).map((h) => norm(h.text));
  for (const item of character.arsenal) {
    const cleanAnchor = norm(item.anchor);
    if (ownSpeeches.some((text) => text.includes(cleanAnchor))) {
      used.add(item.anchor);
    }
  }
  return used;
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
async function frameMotion(question, P) {
  let partialMotion = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callClaude(P.frameSystem(), P.frameUser(question, attempt), { kind: "frame", attempt, lang: P.lang }, 600);
    const m = parseMotion(raw);
    if (m) return m;
    partialMotion ||= raw.match(/"motion"\s*:\s*"([^"]+)"/)?.[1]?.trim() || "";
    console.warn(`[debate] 立题第${attempt + 1}次解析失败：`, raw.slice(0, 300));
  }
  const short = partialMotion || question.replace(/\s+/g, " ").trim();
  const max = P.lang === "en" ? 90 : 40;
  return { motion: short.length > max ? short.slice(0, max - 1) + "…" : short, a: "", b: "", needsEdit: true };
}


async function compressToAdvice(P, character, motion, verdictItem, ownLines) {
  const raw = await callClaude(P.adviceSystem(character), P.adviceUser(motion, verdictItem.stance, ownLines), { kind: "advice", charId: character.id, lang: P.lang }, 200);
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
    lang: rawLang = "zh",
  } = req.body || {};

  if (!question || typeof question !== "string" || question.length < 2) {
    res.status(400).json({ error: "question缺失或过短" });
    return;
  }
  if (!API_KEY && !MOCK) {
    res.status(500).json({ error: "服务端未配置CLAUDE_API_KEY" });
    return;
  }

  const lang = LANGS.includes(rawLang) ? rawLang : "zh";
  const P = getPrompts(lang);

  try {
    // ---- frame 阶段：立题，不需要角色 ----
    if (phase === "frame") {
      const m = await frameMotion(question, P);
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

    const characters = await Promise.all(characterIds.map((id) => loadCharacter(id, lang)));
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
          const text = await compressToAdvice(P, character, motion, v, lines);
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
          const systemPrompt = P.system(character, question, motion, deriveUsedAnchors(character, history), updatedPrivateMemory[character.id]);
          const userMessage = P.user({ round, motion, history, stances: {}, character, characters });
          const p = await generateSpeech(systemPrompt, userMessage, { kind: "speech", charIndex: idx, round, name: character.name, lang }, null);
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
        speeches.push({ ...entry, tag: P.tag(round, "advance", null, characterMap), shiftFrom: null });
      }
    } else {
      // 交锋轮：顺序执行，后发言的人能看到本轮前面的人刚说的话；发言顺序按轮次轮换
      const rotation = (round - 1) % characters.length;
      const speakingOrder = [...characters.slice(rotation), ...characters.slice(0, rotation)];

      if (interjection) {
        interjectionEntry = { charId: "user", name: P.userName, text: interjection, round };
        workingHistory.push(interjectionEntry);
      }

      for (let i = 0; i < speakingOrder.length; i++) {
        const character = speakingOrder[i];
        const idx = characters.indexOf(character);
        const isFirstSpeaker = i === 0;
        const systemPrompt = P.system(character, question, motion, deriveUsedAnchors(character, workingHistory), updatedPrivateMemory[character.id]);
        const userMessage = P.user({
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
        const p = await generateSpeech(systemPrompt, userMessage, { kind: "speech", charIndex: idx, round, name: character.name, targets, lang }, liveStances[character.id]);
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
          tag: P.tag(round, responseType, target, characterMap),
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
