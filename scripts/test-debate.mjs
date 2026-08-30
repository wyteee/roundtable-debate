// 圆桌 · 阶段1核心机制验证脚本
// 用法：
//   export CLAUDE_API_KEY=你的key
//   node scripts/test-debate.mjs
//   node scripts/test-debate.mjs munger jobs beauvoir   （指定角色组合）
//
// 目的：不接UI、不接完整runDebate编排，只验证"人物卡+轮次机制"本身
// 是否好玩、像本人、有没有AI腔。全部输出直接打印在终端。
//
// 本版本新增：私有记忆机制。每次发言模型必须同时产出
// 【公开发言】（进入history，其他角色和用户都看得到）
// 【内心活动】（只喂给角色自己，测试阶段打印出来方便你验证，
//              正式产品里这部分对用户完全不可见）

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
const QUESTION = process.env.DEBATE_QUESTION || "韬光养晦更好，还是锋芒毕露更好？";

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

function buildSystemPrompt(character, question, usedAnchors, privateMemoryList) {
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

  const privateMemoryText =
    privateMemoryList && privateMemoryList.length > 0
      ? `\n【你的私有记忆 —— 只有你自己知道，其他人和用户都看不到】
这是你在本场之前每一轮心里真实的想法（不是你说出口的话）：
${privateMemoryList.map((m, i) => `第${i + 1}轮内心活动：${m}`).join("\n")}

你现在的内心活动要如实反映"到目前为止真实发生的事"，不要预设情绪必须
朝某个方向发展（比如不要默认情绪必须越来越愤怒/越来越激动）。
真正决定你此刻感受的，是：刚才有没有人真的戳中了你的痛处或漏洞
（那可能是恼火、不安、想反击）；有没有人说了你其实部分认同的话
（那可能是松动、意外、不情愿的服气）；还是这一切对你来说其实
只是一场智力上还算有意思的交锋（那可能是平静、甚至带点玩味的轻蔑）。
情绪可以升级，也可以缓和，也可以毫无变化——取决于内容本身，不是套路。\n`
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
- 如果这不是开场轮，每次最多只能针对*一个人*的*一句话*做回应，绝不同时回应多个人，
  这会导致发言过长；也不是每次都要回应别人，可以直接推进你自己对问题本身的分析
- 无论是否回应别人，发言结尾都必须有一句清晰的判断句，明确重申或推进
  你对问题本身的立场，不能整段话都缠着对方举的具体案例细节打转
- relations字段里如果对某人写的是"认可/赞赏/尊重"，这是真实态度，不是
  礼貌性铺垫——遇到那个人说了你认可的内容，允许并鼓励直接表达认同，
  不要每次都默认要挑刺，一场只有反驳没有认同的辩论是失真的
- 绝不说"作为一个历史人物"「值得深思」这类AI腔或第三人称抽离的话
- 直接用第一人称说话，就是在圆桌上开口发言

【输出格式 —— 严格遵守，否则脚本无法解析】
你必须只输出一个合法JSON对象，不要有任何其他文字、不要用markdown代码块包裹，
格式如下：
{"speech": "你的公开发言正文", "inner_thought": "你此刻真实的内心活动，一句话，20字以内，不会给任何人看，可以比发言更直接、更不加掩饰——但情绪类型要如实对应当下发生的事，不要默认必须是愤怒或激动，平静/松动/玩味/得意都是合理的真实反应"}`;
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
    throw new Error(`API调用失败 (${res.status})：${errText}`);
  }

  const data = await res.json();
  const textBlocks = data.content.filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n").trim();
}

// 从模型输出里解析出 {speech, inner_thought}，
// 容错处理：万一模型没听话加了markdown代码块或多余文字，尽量抢救
function parseSpeechJSON(rawText, characterName) {
  let text = rawText.trim();

  // 去掉可能出现的 ```json ... ``` 包裹
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  // 找第一个 { 到最后一个 } 之间的内容，防止前后有多余文字
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(text);
    return {
      speech: parsed.speech || "（解析失败：缺少speech字段）",
      innerThought: parsed.inner_thought || "（无内心活动）",
    };
  } catch (err) {
    console.warn(`\n[警告] ${characterName} 的输出不是合法JSON，原样当作发言处理，内心活动缺失。`);
    return { speech: rawText.trim(), innerThought: "（JSON解析失败，无法提取）" };
  }
}

function printSpeech(name, speech, innerThought) {
  console.log(`\n【${name}】`);
  console.log(speech);
  console.log(`（内心活动 · 仅测试可见）：${innerThought}`);
  console.log("─".repeat(50));
}

// ---------- 主流程 ----------

async function main() {
  console.log("=".repeat(50));
  console.log(`圆桌辩论测试 · 问题："${QUESTION}"`);
  console.log("=".repeat(50));

  const characters = await Promise.all(CHARACTER_IDS.map(loadCharacter));

  const usedAnchors = new Map(characters.map((c) => [c.id, new Set()]));
  const privateMemory = new Map(characters.map((c) => [c.id, []]));

  function trackUsedAnchors(character, speechText) {
    const set = usedAnchors.get(character.id);
    for (const item of character.arsenal) {
      const cleanAnchor = item.anchor.replace(/["'"「」]/g, "");
      if (speechText.includes(cleanAnchor)) {
        set.add(item.anchor);
      }
    }
  }

  // history：只存公开发言，这是其他角色和用户都能看到的部分
  const history = [];

  function historyText() {
    if (history.length === 0) return "（目前还没有人发言）";
    return history.map((h) => `${h.name}：${h.text}`).join("\n\n");
  }

  async function speak(character, userMessage) {
    const systemPrompt = buildSystemPrompt(
      character,
      QUESTION,
      usedAnchors.get(character.id),
      privateMemory.get(character.id)
    );
    const rawText = await callClaude(systemPrompt, userMessage);
    const { speech, innerThought } = parseSpeechJSON(rawText, character.name);

    printSpeech(character.name, speech, innerThought);
    trackUsedAnchors(character, speech);
    privateMemory.get(character.id).push(innerThought);
    history.push({ name: character.name, text: speech });
  }

  // ---- 开场轮：三人并行，各自独立表态，互不看彼此 ----
  console.log("\n>>> 开场轮（三人各自独立表态）\n");

  for (const character of characters) {
    const userMessage = `请针对今晚的问题"${QUESTION}"，给出你的开场表态。这是第一轮，你还没听到其他人说话，只说出你自己的立场即可。`;
    await speak(character, userMessage);
  }

  // ---- 交锋轮：按顺序轮流发言，能看到之前所有公开发言 ----
  for (let round = 1; round <= TEST_ROUNDS; round++) {
    console.log(`\n>>> 第 ${round} 轮交锋\n`);

    for (const character of characters) {
      const userMessage = `到目前为止圆桌上的发言记录：

${historyText()}

现在轮到你发言，从下面三种方式里选一种（不用每次都选反驳，
你自己判断哪种此刻更真实、更符合你和对方的关系）：

方式A · 反驳：挑*恰好一位*发言者刚才说的*恰好一句*话，正面反驳它
（追问漏洞、指出矛盾都行）。只能针对一个人的一句话，不要同时回应多个人，
否则会说太长。

方式B · 推进：不引用任何人，直接用你自己的世界观继续深入分析
"${QUESTION}"这个问题本身，提出新的角度。

方式C · 结盟：如果*恰好一位*发言者刚才说的话，跟你自己的世界观其实
有真实的共鸣（去看你的relations字段里对这个人是不是有正面认可的部分），
就大方承认、借力把这个观点往前推，不必为了显得"有交锋"硬找茬反驳。
relations里写着认可的部分，要认真当真，不是每次都只挑里面批评的那半句说。

无论选哪种，发言的**最后一句话**必须是一句清晰的判断句，
明确重申或推进你对"${QUESTION}"这个问题本身的立场——
不能整段话都缠着对方举的具体例子打转（比如具体某个历史事件、
某次具体决策），必须让人一眼看出你此刻站在这个问题的哪一边、为什么。
如果发现自己在纯粹和某人较劲某个细节、已经忘了原本在讨论什么问题，
说明跑题了，要在结尾这句话里拉回来。`;

      await speak(character, userMessage);
    }
  }

  console.log("\n测试结束。对照下面几点自查：");
  console.log("1. 三人开场立场是否互不重复，能不能追溯回各自世界观？");
  console.log("2. 有没有自发的反驳/结盟（不是被指令强制的）？");
  console.log("3. 有没有出现'作为AI''值得深思''首先其次'这类AI腔？");
  console.log("4. 三人的语气是否有明显区分度，还是读起来像同一个人在说话？");
  console.log("5. 【新增】内心活动是否比公开发言更直接/更情绪化？");
  console.log("6. 【新增】同一个角色的内心活动，是否随轮次累积情绪（比如越来越不耐烦），");
  console.log("   而不是每轮都是差不多的平静状态？");
}

main().catch((err) => {
  console.error("\n运行出错：", err.message);
  process.exit(1);
});
