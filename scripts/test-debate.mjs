// 圆桌 · 阶段1核心机制验证脚本
// 用法：
//   export CLAUDE_API_KEY=你的key
//   node scripts/test-debate.mjs
//
// 目的：不接UI、不接完整runDebate编排，只验证"人物卡+轮次机制"本身
// 是否好玩、像本人、有没有AI腔。全部输出直接打印在终端。

import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARACTERS_DIR = path.join(__dirname, "..", "characters");

const API_KEY = process.env.CLAUDE_API_KEY;
if (!API_KEY) {
  console.error("错误：没有找到 CLAUDE_API_KEY 环境变量。");
  console.error("先执行：export CLAUDE_API_KEY=你的key");
  process.exit(1);
}

const MODEL = "claude-sonnet-5";
const QUESTION = "韬光养晦更好，还是锋芒毕露更好？";

// 本次测试用哪3位角色：默认尼采/马基雅维利/Jobs，
// 也可以在命令行里指定，例如：
//   node scripts/test-debate.mjs munger jobs beauvoir
const DEFAULT_CHARACTER_IDS = ["nietzsche", "machiavelli", "jobs"];
const CHARACTER_IDS =
  process.argv.length >= 5 ? process.argv.slice(2, 5) : DEFAULT_CHARACTER_IDS;

// 标准交锋轮数（测试阶段先跑2轮，不用跑满3-4轮节省成本）
const TEST_ROUNDS = 2;

// ---------- 工具函数 ----------

async function loadCharacter(id) {
  const filePath = path.join(CHARACTERS_DIR, `${id}.json`);
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

function buildSystemPrompt(character, question, usedAnchors) {
  const arsenalText = character.arsenal
    .map((a) => `- ${a.point}（锚点："${a.anchor}"）`)
    .join("\n");

  const relationsText = Object.entries(character.relations)
    .map(([id, view]) => `- 对${id}：${view}`)
    .join("\n");

  const dialoguesText = character.example_dialogues
    .map((d) => `- ${d}`)
    .join("\n");

  const taboosText = character.taboos.map((t) => `- ${t}`).join("\n");

  const usedAnchorsText =
    usedAnchors && usedAnchors.size > 0
      ? `\n【你本场已经用过的锚点/梗，不要再重复，换一个论点库里还没用过的角度】\n${[...usedAnchors].map((a) => `- ${a}`).join("\n")}\n`
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

【本场规则】
- 今晚圆桌辩论的问题是："${question}"
- 每次发言硬限150字以内，短促有力，不要总结陈词，不要说"首先""其次"
- 立场必须完全从你自己的世界观（creed/voice/arsenal）中涌现，不接受任何外部分配的立场
- 核心是用你的世界观去分析问题本身——bio和arsenal里的锚点/轶事只是偶尔用来
  举例的调味品，不是每次发言的主料，绝不能让"讲自己的经历"取代真实论证
- 如果这不是开场轮，每次最多只能针对*一个人*的*一句话*做回应，绝不同时回应多个人，
  这会导致发言过长；也不是每次都要回应别人，可以直接推进你自己对问题本身的分析
- 无论是否回应别人，发言结尾都必须有一句清晰的判断句，明确重申或推进
  你对问题本身的立场，不能整段话都缠着对方举的具体案例细节打转
- 绝不说"作为一个历史人物"「值得深思」这类AI腔或第三人称抽离的话
- 直接用第一人称说话，就是在圆桌上开口发言`;
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
      max_tokens: 700,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API调用失败 (${res.status})：${errText}`);
  }

  const data = await res.json();
  const textBlocks = data.content.filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n").trim();
}

function printSpeech(name, text) {
  console.log(`\n【${name}】`);
  console.log(text);
  console.log("─".repeat(50));
}

// ---------- 主流程 ----------

async function main() {
  console.log("=".repeat(50));
  console.log(`圆桌辩论测试 · 问题："${QUESTION}"`);
  console.log("=".repeat(50));

  const characters = await Promise.all(CHARACTER_IDS.map(loadCharacter));

  // 每个角色一个 Set，记录本场已经用过的 anchor 原文，用于提醒模型别重复
  const usedAnchors = new Map(characters.map((c) => [c.id, new Set()]));

  function trackUsedAnchors(character, speechText) {
    const set = usedAnchors.get(character.id);
    for (const item of character.arsenal) {
      // 简单子串匹配：锚点原文（去掉引号）如果出现在发言里，就记为已使用
      const cleanAnchor = item.anchor.replace(/["'"「」]/g, "");
      if (speechText.includes(cleanAnchor)) {
        set.add(item.anchor);
      }
    }
  }

  // history：记录到目前为止所有发言的文本（角色名+内容），
  // 拼给下一位发言者作为上下文
  const history = [];

  function historyText() {
    if (history.length === 0) return "（目前还没有人发言）";
    return history.map((h) => `${h.name}：${h.text}`).join("\n\n");
  }

  // ---- 开场轮：三人并行，各自独立表态，互不看彼此 ----
  console.log("\n>>> 开场轮（三人各自独立表态）\n");

  for (const character of characters) {
    const systemPrompt = buildSystemPrompt(character, QUESTION, usedAnchors.get(character.id));
    const userMessage = `请针对今晚的问题"${QUESTION}"，给出你的开场表态。这是第一轮，你还没听到其他人说话，只说出你自己的立场即可。`;

    const speech = await callClaude(systemPrompt, userMessage);
    printSpeech(character.name, speech);
    trackUsedAnchors(character, speech);
    history.push({ name: character.name, text: speech });
  }

  // ---- 交锋轮：按顺序轮流发言，能看到之前所有发言 ----
  for (let round = 1; round <= TEST_ROUNDS; round++) {
    console.log(`\n>>> 第 ${round} 轮交锋\n`);

    for (const character of characters) {
      const systemPrompt = buildSystemPrompt(character, QUESTION, usedAnchors.get(character.id));
      const userMessage = `到目前为止圆桌上的发言记录：

${historyText()}

现在轮到你发言，从下面两种方式里选一种（不用每次都选反驳，你自己判断哪种此刻更有意思）：

方式A · 回应：挑*恰好一位*发言者刚才说的*恰好一句*话，正面回应它
（反驳/追问漏洞/部分认同都行）。只能针对一个人的一句话，不要同时回应多个人，
否则会说太长。

方式B · 推进：不引用任何人，直接用你自己的世界观继续深入分析
"${QUESTION}"这个问题本身，提出新的角度。

无论选哪种，发言的**最后一句话**必须是一句清晰的判断句，
明确重申或推进你对"${QUESTION}"这个问题本身的立场——
不能整段话都缠着对方举的具体例子打转（比如具体某个历史事件、
某次具体决策），必须让人一眼看出你此刻站在这个问题的哪一边、为什么。
如果发现自己在纯粹和某人较劲某个细节、已经忘了原本在讨论什么问题，
说明跑题了，要在结尾这句话里拉回来。`;

      const speech = await callClaude(systemPrompt, userMessage);
      printSpeech(character.name, speech);
      trackUsedAnchors(character, speech);
      history.push({ name: character.name, text: speech });
    }
  }

  console.log("\n测试结束。对照下面几点自查：");
  console.log("1. 三人开场立场是否互不重复，能不能追溯回各自世界观？");
  console.log("2. 有没有自发的反驳/结盟（不是被指令强制的）？");
  console.log("3. 有没有出现'作为AI''值得深思''首先其次'这类AI腔？");
  console.log("4. 三人的语气是否有明显区分度，还是读起来像同一个人在说话？");
}

main().catch((err) => {
  console.error("\n运行出错：", err.message);
  process.exit(1);
});
