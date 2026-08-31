// 圆桌 · POST /api/debate —— 按轮次请求版本（方案A）
//
// 架构变更说明（相对于原SSE长连接版本）：
// 原版本一次请求内跑完整场辩论（开场+全部交锋轮+收尾），靠SSE持续推送。
// 问题：①单次Serverless函数执行时间随轮次线性增长，10轮硬上限时有超时风险
//      ②用户插话无法在已经在跑的长连接里"注入"，因为请求体在连接建立时已经固定
// 现在改为：前端每一轮单独发一次请求，后端不维护任何跨请求状态（真正的无状态），
// 完整的历史发言和私有记忆由前端在每次请求时完整传入，后端只负责"根据已有上下文，
// 生成接下来这一轮该说什么"，生成完立即返回，不再长期占用连接。
//
// 入参（JSON body）：
//   {
//     question: string,
//     characterIds: string[3],
//     round: number,                          // 0=开场；1~10=交锋轮
//     history: {charId,name,text}[],          // 到目前为止全部公开发言（不含本轮）
//     privateMemory: {[charId]: string[]},    // 到目前为止每人的私有记忆
//     interjection?: string,                   // 用户在本轮开始前插的话（如果有）
//     phase?: 'debate' | 'closing'             // 默认'debate'；'closing'用于收尾高光
//   }
//
// 出参（普通JSON，不再是SSE）：
//   debate阶段: { speeches, privateMemory, suggestEnd, bannerText?, hardCapped }
//   closing阶段: { advice: {charId,text}[] }

import { readFile } from "fs/promises";
import path from "path";

const API_KEY = process.env.CLAUDE_API_KEY;
const MODEL = "claude-sonnet-5";
const STANDARD_ROUNDS = Number(process.env.DEBATE_ROUNDS) || 4;
const HARD_CAP_ROUNDS = 10;

const CHARACTERS_DIR = path.join(process.cwd(), "characters");

// 一轮包含最多3次连续的Claude调用（含开场轮），默认的Serverless执行时长上限
// （Vercel Hobby默认10秒）大概率不够用，必须显式延长。Hobby计划最高可设到60秒，
// Pro及以上可以设更高。如果实测单轮仍然经常超时，优先考虑升级Vercel套餐或
// 减少max_tokens，而不是继续往上调这个数字掩盖问题。
export const config = {
  maxDuration: 60,
};

async function loadCharacter(id) {
  const filePath = path.join(CHARACTERS_DIR, `${id}.json`);
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

// 原来usedAnchors是靠内存里的Set跨请求累积的，现在后端每次请求都是全新开始，
// 只能从前端传入的完整history里，现场扫描这个角色自己说过的话，
// 检测里面提到了arsenal里的哪些锚点，重新推算出"已经用过的锚点集合"。
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

function buildSystemPrompt(character, question, usedAnchors, privateMemoryList) {
  const arsenalText = character.arsenal
    .map((a) => `- ${a.point}（锚点："${a.anchor}"）`)
    .join("\n");

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
痛处或漏洞，还是有人说了你其实部分认同的话，还是这一切对你来说其实
只是一场智力上还算有意思的交锋。情绪可以升级，也可以缓和，也可以
毫无变化——取决于内容本身，不是套路。\n`
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
【本场规则】
- 今晚圆桌辩论的问题是："${question}"
- 每次发言硬限150字以内，短促有力，不要总结陈词，不要说"首先""其次"
- 立场必须完全从你自己的世界观（creed/voice/arsenal）中涌现，不接受任何外部分配的立场
- 核心是用你的世界观去分析问题本身——bio和arsenal里的锚点/轶事只是偶尔用来
  举例的调味品，不是每次发言的主料，绝不能让"讲自己的经历"取代真实论证
- 发言结尾都必须有一句清晰的判断句，明确重申或推进你对问题本身的立场
- relations字段里如果对某人写的是"认可/赞赏/尊重"，这是真实态度，遇到那个人
  说了你认可的内容，允许并鼓励直接表达认同，不要每次都默认要挑刺
- 绝不说"作为一个历史人物"「值得深思」这类AI腔或第三人称抽离的话
- 直接用第一人称说话，就是在圆桌上开口发言

【输出格式 —— 严格遵守，否则接口无法解析】
必须只输出一个合法JSON对象，不要有任何其他文字、不要用markdown代码块包裹：
{"speech": "公开发言正文", "inner_thought": "内心活动，20字以内", "response_type": "回应类型", "target": "回应对象的id或null"}

response_type 只能是以下三选一：
- "rebut"（反驳）：针对某人的话正面反驳
- "ally"（结盟）：认同某人的话并借力推进
- "advance"（推进）：不针对任何人，直接推进自己对问题本身的分析

target：如果response_type是"rebut"或"ally"，填对应角色的id（比如"nietzsche"）；
如果是"advance"，填null。

【极重要的格式限制】
speech 和 inner_thought 的正文内容里，绝对不能出现英文直引号字符 " ——
这个字符会破坏JSON格式。想强调或引用时，一律改用中文引号「」或单引号 '。`;
}

async function callClaude(systemPrompt, userMessage) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
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
  return textBlocks.map((b) => b.text).join("\n").trim();
}

function parseSpeechOutput(rawText) {
  let text = rawText.trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(text);
    return {
      speech: parsed.speech || "",
      innerThought: parsed.inner_thought || "",
      responseType: parsed.response_type || "advance",
      target: parsed.target || null,
    };
  } catch (err) {
    const speechRescue = text.match(/"speech"\s*:\s*"([\s\S]*?)"\s*,\s*"inner_thought"/);
    if (speechRescue) {
      return {
        speech: speechRescue[1].trim(),
        innerThought: "",
        responseType: "advance",
        target: null,
      };
    }
    return { speech: rawText.trim(), innerThought: "", responseType: "advance", target: null };
  }
}

function buildTag(round, responseType, target, characterMap) {
  if (round === 0) return "开场";
  const targetName = target && characterMap.has(target) ? characterMap.get(target).name : null;
  if (responseType === "rebut" && targetName) return `反驳 ${targetName}`;
  if (responseType === "ally" && targetName) return `认同 ${targetName}`;
  return "推进论点";
}

function scoreSpeech(text) {
  let score = 0;
  const len = text.length;
  if (len >= 60 && len <= 180) score += 3;
  else score += 1;
  const questionMarks = (text.match(/？/g) || []).length;
  score -= questionMarks * 2;
  if (/[。]$/.test(text.trim())) score += 2;
  return score;
}

function pickTopLines(character, history, count = 2) {
  const speeches = history.filter((h) => h.charId === character.id).map((h) => h.text);
  const scored = speeches.map((text) => ({ text, score: scoreSpeech(text) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map((s) => s.text);
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

async function compressToAdvice(character, bestLines) {
  const systemPrompt = buildAdviceSystemPrompt(character);
  const userMessage = `基于你在本场说过的这些话：
${bestLines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

把其中最重要的判断浓缩成一句给用户的忠告，不超过40字，保持你一贯的语气，
不要说本场没说过的新观点，不要加任何引号或前缀，只输出这一句话本身。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return raw.trim();
}

function historyText(history) {
  if (!history || history.length === 0) return "（目前还没有人发言）";
  return history.map((h) => `${h.name}：${h.text}`).join("\n\n");
}

// 生成"这一轮该说什么"的userMessage。
// isFirstSpeakerThisRound + interjection同时成立时，这位发言者要先处理插话，
// 这是PRD里"用户插话特殊处理"机制在按轮次架构下的落地方式：
// 插话只影响紧跟其后的那一位发言者，不是这一轮全部3人。
function buildUserMessage(round, question, history, isFirstSpeakerThisRound, interjection) {
  if (round === 0) {
    return `请针对今晚的问题"${question}"，给出你的开场表态。这是第一轮，你还没听到其他人说话，只说出你自己的立场即可。`;
  }

  const interjectionInstruction =
    isFirstSpeakerThisRound && interjection
      ? `\n\n【重要 —— 用户刚刚插话了】
用户说："${interjection}"
你是插话之后第一个发言的人，必须优先处理这条插话：
先指出这个观点里最脆弱的一个假设，攻击它；如果你部分同意，要先明确说出
你不同意的部分是什么，再谈你同意的部分。处理完插话之后，仍然要回到
"${question}"这个问题本身给出清晰判断，不能只回应插话就结束。`
      : "";

  return `到目前为止圆桌上的发言记录：

${historyText(history)}

现在轮到你发言，从下面三种方式里选一种（不用每次都选反驳，你自己判断哪种此刻更真实）：

方式A · 反驳：挑*恰好一位*发言者刚才说的*恰好一句*话，正面反驳它。

方式B · 推进：不引用任何人，直接用你自己的世界观继续深入分析"${question}"这个问题本身。

方式C · 结盟：如果*恰好一位*发言者说的话跟你的世界观有真实共鸣，大方承认、借力推进。

无论选哪种，发言的**最后一句话**必须是一句清晰的判断句，明确重申或推进
你对"${question}"这个问题本身的立场，不能整段话都缠着对方举的具体例子打转。${interjectionInstruction}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "只支持POST" });
    return;
  }

  const {
    question,
    characterIds,
    round,
    history = [],
    privateMemory = {},
    interjection = null,
    phase = "debate",
  } = req.body || {};

  if (!question || typeof question !== "string" || question.length < 2) {
    res.status(400).json({ error: "question缺失或过短" });
    return;
  }
  if (!Array.isArray(characterIds) || characterIds.length !== 3) {
    res.status(400).json({ error: "characterIds必须是长度为3的数组" });
    return;
  }
  if (!API_KEY) {
    res.status(500).json({ error: "服务端未配置CLAUDE_API_KEY" });
    return;
  }

  try {
    const characters = await Promise.all(characterIds.map(loadCharacter));
    const characterMap = new Map(characters.map((c) => [c.id, c]));

    // ---- closing阶段：生成收尾高光，跟具体某一轮无关，独立处理 ----
    if (phase === "closing") {
      const advice = [];
      for (const character of characters) {
        const bestLines = pickTopLines(character, history);
        const text = await compressToAdvice(character, bestLines);
        advice.push({ charId: character.id, text });
      }
      res.status(200).json({ advice });
      return;
    }

    // ---- debate阶段：只生成"这一轮"的3条发言 ----
    if (typeof round !== "number" || round < 0) {
      res.status(400).json({ error: "round缺失或非法" });
      return;
    }

    // 深拷贝一份privateMemory，本轮生成的新内容往这份拷贝里追加，
    // 不直接改req.body里的对象（虽然这里改不改其实无所谓，避免以后复用出问题）
    const updatedPrivateMemory = {};
    for (const c of characters) {
      updatedPrivateMemory[c.id] = [...(privateMemory[c.id] || [])];
    }

    let speeches = [];

    if (round === 0) {
      // 开场轮：三人互相之间没有依赖关系（都还没听到别人说话），
      // 可以并行跑，把总耗时从"三人耗时相加"压到"最慢的那一人"，
      // 避免不必要地顶着Serverless执行时长上限
      const results = await Promise.all(
        characters.map(async (character) => {
          const usedAnchors = deriveUsedAnchors(character, history);
          const systemPrompt = buildSystemPrompt(
            character,
            question,
            usedAnchors,
            updatedPrivateMemory[character.id]
          );
          const userMessage = buildUserMessage(round, question, history, false, null);
          const raw = await callClaude(systemPrompt, userMessage);
          const parsed = parseSpeechOutput(raw);
          return { character, ...parsed };
        })
      );

      for (const { character, speech, innerThought, responseType, target } of results) {
        updatedPrivateMemory[character.id].push(innerThought);
        const tag = buildTag(round, responseType, target, characterMap);
        speeches.push({ charId: character.id, name: character.name, text: speech, tag });
      }
    } else {
      // 交锋轮：必须顺序执行——第二位发言者要能看到本轮里第一位刚说的话，
      // 插话的"消费一次"逻辑也依赖固定的发言顺序，不能并行
      let firstSpeakerConsumedInterjection = false;
      // history是从req.body解构出来的const，不能直接重新赋值；
      // 这里单独开一个可变的累积变量，来拼接"传入的历史 + 本轮已生成的部分"，
      // 只用于给后说话的角色展示上下文，不影响原始history结构
      let workingHistory = [...history];

      for (const character of characters) {
        const usedAnchors = deriveUsedAnchors(character, workingHistory);
        const systemPrompt = buildSystemPrompt(
          character,
          question,
          usedAnchors,
          updatedPrivateMemory[character.id]
        );

        const isFirstSpeakerThisRound = !firstSpeakerConsumedInterjection;
        const userMessage = buildUserMessage(
          round,
          question,
          workingHistory,
          isFirstSpeakerThisRound,
          interjection
        );
        if (isFirstSpeakerThisRound && interjection) {
          firstSpeakerConsumedInterjection = true; // 插话只消费一次，给这一轮第一位发言者
        }

        const raw = await callClaude(systemPrompt, userMessage);
        const { speech, innerThought, responseType, target } = parseSpeechOutput(raw);

        updatedPrivateMemory[character.id].push(innerThought);
        workingHistory = [...workingHistory, { charId: character.id, name: character.name, text: speech }];

        const tag = buildTag(round, responseType, target, characterMap);
        speeches.push({ charId: character.id, name: character.name, text: speech, tag });
      }
    }

    const hardCapped = round >= HARD_CAP_ROUNDS;
    const suggestEnd = hardCapped || round >= STANDARD_ROUNDS;
    const bannerText = hardCapped
      ? "圆桌已经聊了很久，我们该收尾了"
      : suggestEnd
      ? "圆桌觉得聊透了，要听听最终忠告吗？"
      : undefined;

    res.status(200).json({
      speeches,
      privateMemory: updatedPrivateMemory,
      suggestEnd,
      bannerText,
      hardCapped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
