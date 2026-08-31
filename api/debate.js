// 圆桌 · POST /api/debate —— 正式接口
//
// 入参（JSON body）：
//   { "question": "我该不该辞职", "characterIds": ["nietzsche", "machiavelli", "jobs"] }
//
// 出参：SSE流，每条事件是一行 `data: {...}\n\n`，event.type 有四种：
//   - "speech" : { type, charId, text, tag }         公开发言，进入前端的messages
//   - "banner" : { type, text }                       建议收尾横幅
//   - "advice" : { type, charId, text }                收尾高光忠告
//   - "done"   : { type }                              流结束
//   - "error"  : { type, message }                     出错时提前终止
//
// 复用逻辑来自 scripts/test-debate.mjs（已验证过人物卡+轮次+私有记忆+收尾高光），
// 这里做的改造：①从命令行脚本变成HTTP接口 ②新增[标签]分类供前端渲染 ③加SSE推送

import { readFile } from "fs/promises";
import path from "path";

const API_KEY = process.env.CLAUDE_API_KEY;
const MODEL = "claude-sonnet-5";
const STANDARD_ROUNDS = Number(process.env.DEBATE_ROUNDS) || 4;

const CHARACTERS_DIR = path.join(process.cwd(), "characters");

async function loadCharacter(id) {
  const filePath = path.join(CHARACTERS_DIR, `${id}.json`);
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
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
    // 正则抢救
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

// 把 responseType + target 拼成前端要的 tag 字符串
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "只支持POST" });
    return;
  }

  const { question, characterIds } = req.body || {};

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

  // SSE响应头
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const characters = await Promise.all(characterIds.map(loadCharacter));
    const characterMap = new Map(characters.map((c) => [c.id, c]));

    const usedAnchors = new Map(characters.map((c) => [c.id, new Set()]));
    const privateMemory = new Map(characters.map((c) => [c.id, []]));
    const history = []; // { charId, name, text }

    function trackUsedAnchors(character, speechText) {
      const set = usedAnchors.get(character.id);
      for (const item of character.arsenal) {
        const cleanAnchor = item.anchor.replace(/["'"「」]/g, "");
        if (speechText.includes(cleanAnchor)) set.add(item.anchor);
      }
    }

    function historyText() {
      if (history.length === 0) return "（目前还没有人发言）";
      return history.map((h) => `${h.name}：${h.text}`).join("\n\n");
    }

    async function speak(character, userMessage, round) {
      const systemPrompt = buildSystemPrompt(
        character,
        question,
        usedAnchors.get(character.id),
        privateMemory.get(character.id)
      );
      const raw = await callClaude(systemPrompt, userMessage);
      const { speech, innerThought, responseType, target } = parseSpeechOutput(raw);

      trackUsedAnchors(character, speech);
      privateMemory.get(character.id).push(innerThought);
      history.push({ charId: character.id, name: character.name, text: speech });

      const tag = buildTag(round, responseType, target, characterMap);
      send({ type: "speech", charId: character.id, text: speech, tag });
    }

    // 开场轮
    for (const character of characters) {
      const userMessage = `请针对今晚的问题"${question}"，给出你的开场表态。这是第一轮，你还没听到其他人说话，只说出你自己的立场即可。`;
      await speak(character, userMessage, 0);
    }

    // 交锋轮
    for (let round = 1; round <= STANDARD_ROUNDS; round++) {
      for (const character of characters) {
        const userMessage = `到目前为止圆桌上的发言记录：

${historyText()}

现在轮到你发言，从下面三种方式里选一种（不用每次都选反驳，你自己判断哪种此刻更真实）：

方式A · 反驳：挑*恰好一位*发言者刚才说的*恰好一句*话，正面反驳它。

方式B · 推进：不引用任何人，直接用你自己的世界观继续深入分析"${question}"这个问题本身。

方式C · 结盟：如果*恰好一位*发言者说的话跟你的世界观有真实共鸣，大方承认、借力推进。

无论选哪种，发言的**最后一句话**必须是一句清晰的判断句，明确重申或推进
你对"${question}"这个问题本身的立场，不能整段话都缠着对方举的具体例子打转。`;

        await speak(character, userMessage, round);
      }
    }

    // 建议收尾横幅
    send({ type: "banner", text: "圆桌觉得聊透了，要听听最终忠告吗？" });

    // 收尾高光
    for (const character of characters) {
      const bestLines = pickTopLines(character, history);
      const advice = await compressToAdvice(character, bestLines);
      send({ type: "advice", charId: character.id, text: advice });
    }

    send({ type: "done" });
    res.end();
  } catch (err) {
    send({ type: "error", message: err.message });
    res.end();
  }
}
