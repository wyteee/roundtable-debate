// 前后端共享的辩论数据结构（和 api/debate.js、api/_ending.js 对应）

export type Stance = 'A' | 'B' | 'MIXED'

export interface Motion {
  motion: string
  a: string
  b: string
}

export interface HistoryEntry {
  charId: string
  name: string
  text: string
  round: number
  stance?: Stance
  confidence?: number
  responseType?: string
  target?: string | null
  changeMind?: string
}

export type EndType = 'consensus' | 'settled' | 'looping'

export interface Ending {
  stances: Record<string, Stance>
  shifts: { charId: string; from: Stance; to: Stance }[]
  stableRounds: number
  allSame: boolean
  unengagedPairs: [string, string][]
  endType: EndType | null
  needNudge: boolean
}

export interface VerdictItem {
  charId: string
  stance: Stance | null
  confidence: number | null
  quote: string
  changeMind: string
  path: Stance[]
}

// 收尾屏需要的全部数据。endReason 记录这场是怎么结束的，用于裁决卡上的一行说明
export type EndReason = EndType | 'budget' | 'hardcap' | 'user'

export interface DebateResult {
  advice: { charId: string; text: string }[]
  verdict: VerdictItem[]
  endReason: EndReason
}

export function stanceLabel(motion: Motion, s: Stance | null | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (s === 'A') return motion.a
  if (s === 'B') return motion.b
  if (s === 'MIXED') return lang === 'en' ? 'Conditional' : '有条件'
  return lang === 'en' ? 'Undecided' : '未表态'
}

// 立场配色：刻意避开嘉宾自己的主色，A/B/有条件三色一眼可分
export const STANCE_COLOR: Record<Stance, string> = {
  A: 'var(--lc-outremer)',
  B: 'var(--lc-vert)',
  MIXED: 'var(--lc-ocre)',
}
