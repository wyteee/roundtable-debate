// 圆桌 · 结束标准（纯规则，不调用 LLM）
//
// 文件名以下划线开头：Vercel 不会把它当成一个 Serverless Function 暴露出去，
// 只作为 debate.js 的内部模块使用；同时方便 scripts/test-ending.mjs 直接单测。
//
// 设计（对应 AGENTS.md 第 5 节"烟雾报警器"，这里第一次真正落地）：
//   每条发言都带角色自报的 stance（A / B / MIXED）。按轮次取每人的立场快照，
//   比较相邻两轮，得到三种信号：
//   1. 有人改立场（shift）       → 不结束，稳定计数清零，前端播一条"X 动摇了"
//   2. 三人立场相同（趋同）      → 第一次出现时，下一轮悄悄提醒一位发言者
//                                  "若你的真实立场与刚才发言冲突，现在必须说出来"；
//                                  提醒过之后仍然一致 → 真共识（consensus）
//   3. 连续 2 轮无人改立场，且每一对立场不同的嘉宾都至少正面反驳过一次
//                                → 分歧已经清楚（settled），再吵也不会变
//   4. 连续 3 轮无人改立场，但仍有立场不同的两人从没正面交锋过
//                                → 在绕圈（looping），各说各的，建议收尾
//   报警器只决定"要不要建议收尾"和"要不要提醒"，从不替角色说话。

export const STANCES = ["A", "B", "MIXED"];
export const SETTLED_STABLE_ROUNDS = 2;
export const LOOPING_STABLE_ROUNDS = 3;

export function normalizeStance(s) {
  if (!s) return null;
  const v = String(s).trim().toUpperCase();
  if (v === "A" || v === "B" || v === "MIXED") return v;
  return null;
}

// 每轮结束时，每位嘉宾的立场快照。某人某轮没发言（理论上不会发生）就沿用上一轮。
export function stanceSnapshots(history, charIds) {
  const rounds = [...new Set(history.filter((h) => h.charId !== "user" && typeof h.round === "number").map((h) => h.round))].sort(
    (a, b) => a - b
  );
  const snapshots = [];
  let prev = {};
  for (const r of rounds) {
    const snap = { ...prev };
    for (const h of history) {
      if (h.round !== r || h.charId === "user") continue;
      const st = normalizeStance(h.stance);
      if (st && charIds.includes(h.charId)) snap[h.charId] = st;
    }
    snapshots.push({ round: r, stances: snap });
    prev = snap;
  }
  return snapshots;
}

function sameSnapshot(a, b, charIds) {
  return charIds.every((id) => a[id] && a[id] === b[id]);
}

// 当前立场不同的每一对嘉宾，是否至少有一方正面反驳过另一方（任一轮）
export function opposingPairsEngaged(history, charIds, stances) {
  const pairs = [];
  for (let i = 0; i < charIds.length; i++) {
    for (let j = i + 1; j < charIds.length; j++) {
      const a = charIds[i];
      const b = charIds[j];
      if (stances[a] && stances[b] && stances[a] !== stances[b]) pairs.push([a, b]);
    }
  }
  const unengaged = pairs.filter(
    ([a, b]) =>
      !history.some(
        (h) =>
          h.responseType === "rebut" &&
          ((h.charId === a && h.target === b) || (h.charId === b && h.target === a))
      )
  );
  return { pairs, unengaged, allEngaged: unengaged.length === 0 };
}

// 主入口。history 需要已经包含本轮发言。
// nudgeRound：趋同提醒是在哪一轮注入的（没注入过就是 null）
export function evaluateEnding({ history, charIds, round, nudgeRound = null }) {
  const snaps = stanceSnapshots(history, charIds);
  const cur = snaps.find((s) => s.round === round) || snaps[snaps.length - 1] || { round, stances: {} };
  const curIdx = snaps.indexOf(cur);
  const prev = curIdx > 0 ? snaps[curIdx - 1] : null;

  const shifts = prev
    ? charIds
        .filter((id) => prev.stances[id] && cur.stances[id] && prev.stances[id] !== cur.stances[id])
        .map((id) => ({ charId: id, from: prev.stances[id], to: cur.stances[id] }))
    : [];

  // 从当前轮往回数，连续多少轮"和上一轮完全一样"
  let stableRounds = 0;
  for (let i = curIdx; i > 0; i--) {
    if (sameSnapshot(snaps[i].stances, snaps[i - 1].stances, charIds)) stableRounds++;
    else break;
  }

  const values = charIds.map((id) => cur.stances[id]).filter(Boolean);
  const allSame = values.length === charIds.length && values.every((v) => v === values[0]);
  const engagement = opposingPairsEngaged(history, charIds, cur.stances);

  let endType = null;
  let needNudge = false;

  if (allSame) {
    if (nudgeRound !== null && round >= nudgeRound) endType = "consensus";
    else needNudge = true;
  } else if (round >= SETTLED_STABLE_ROUNDS && stableRounds >= SETTLED_STABLE_ROUNDS && engagement.allEngaged) {
    endType = "settled";
  } else if (stableRounds >= LOOPING_STABLE_ROUNDS && !engagement.allEngaged) {
    endType = "looping";
  }

  return {
    stances: cur.stances,
    shifts,
    stableRounds,
    allSame,
    unengagedPairs: engagement.unengaged,
    endType,
    needNudge,
  };
}

// 收尾时为每位嘉宾整理裁决数据：最终立场、出处原话、改主意条件、立场变化轨迹
export function buildVerdict(history, charIds) {
  const snaps = stanceSnapshots(history, charIds);
  const final = snaps.length ? snaps[snaps.length - 1].stances : {};
  return charIds.map((id) => {
    const own = history.filter((h) => h.charId === id);
    const finalStance = final[id] || null;
    // 出处：站在最终立场上、信心最高的一条发言；同分取最晚的
    const onFinal = own.filter((h) => normalizeStance(h.stance) === finalStance);
    const pool = onFinal.length ? onFinal : own;
    let quote = null;
    let best = -1;
    for (const h of pool) {
      const c = Number(h.confidence) || 0;
      if (c >= best) {
        best = c;
        quote = h;
      }
    }
    const opening = own.find((h) => h.round === 0);
    const path = [];
    for (const s of snaps) {
      const st = s.stances[id];
      if (st && path[path.length - 1] !== st) path.push(st);
    }
    return {
      charId: id,
      stance: finalStance,
      confidence: quote ? Number(quote.confidence) || null : null,
      quote: quote ? quote.text : "",
      changeMind: opening?.changeMind || "",
      path,
    };
  });
}
