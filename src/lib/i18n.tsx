// 圆桌 · 中英双语
//
// 不引第三方库：一份 zh 字典定义所有 key，en 字典由类型强制覆盖同样的 key，漏一个编译就不过。
// 语言在落地页切换；一场辩论开始后语言固定（人物卡、提示词、辩论内容都跟着这场的语言走）。
// 优先级：URL ?lang=en|zh > 上次选择（localStorage）> 浏览器语言。

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'

type Vars = Record<string, string | number>
type Entry = string | ((v: Vars) => string)

const zh = {
  // landing
  'landing.kicker': 'LATE-NIGHT RADIO · 深夜辩论电台',
  'landing.title': '圆桌',
  'landing.subtitle': 'R O U N D T A B L E',
  'landing.pitch1': '你写下一个人生问题，三位历史名人的「电子灵魂」',
  'landing.pitch2': '围坐在圆桌前，为你辩论一场。',
  'landing.placeholder': '写下你的问题……\n比如：「韬光养晦更好，还是锋芒毕露更好」「该不该辞职去读博」',
  'landing.tooShort': '再写多一点吧——至少 5 个字，圆桌才知道该辩什么。',
  'landing.privacy': '问题不会被保存，圆桌只属于今夜',
  'landing.submit': '召集圆桌 →',
  'landing.guests': "TONIGHT'S GUESTS · 今晚待命的 8 位嘉宾",
  'landing.minLen': 5,

  // motion
  'motion.back': '← 改问题',
  'motion.yourQuestion': 'YOUR QUESTION · 你的问题',
  'motion.title': '立题',
  'motion.desc': '圆桌要辩出一个结果，先把问题立成二选一。不对就直接改——你是主持人。',
  'motion.loading': '正在立题…',
  'motion.retry': '重试',
  'motion.failed': (v: Vars) => `立题失败（状态码 ${v.status}）`,
  'motion.needsEdit': '这个问题有点长，没能自动立好题。把辩题改短一点，再填上 A 和 B 两个选项就能开始；也可以点「换一种立法」再试一次。',
  'motion.label': "TONIGHT'S MOTION · 辩题",
  'motion.sideA': '立场 A',
  'motion.sideB': '立场 B',
  'motion.hint': '嘉宾也可以选「有条件」，但必须说清楚条件是什么。谁站哪边由他们自己决定。',
  'motion.reframe': '换一种立法 ↻',
  'motion.confirm': '就辩这个，去选嘉宾 →',

  // casting
  'casting.back': '← 改辩题',
  'casting.motionLabel': "TONIGHT'S MOTION · 今夜的辩题",
  'casting.title': '选角即选题',
  'casting.desc': '8 选 3 —— 三种世界观的组合，决定这场辩论的走向。',
  'casting.seated': '✓ 已入座',
  'casting.count': (v: Vars) => `${v.n}/${v.max} 位已入座`,
  'casting.needThree': '请选满 3 位嘉宾',
  'casting.start': '开始辩论 →',
  'casting.sep': '　——　',

  // stances
  'stance.mixed': '有条件',
  'stance.none': '未表态',

  // debate
  'debate.preparing': '准备开场',
  'debate.round0': '第 0 轮 · 开场',
  'debate.round': (v: Vars) => `第 ${v.n} 轮 · 交锋`,
  'debate.closing': '正在整理裁决…',
  'debate.clockTitle': '节目时长：只计发言播放的时间',
  'debate.endNow': '我已有答案 · 听裁决',
  'debate.retry': '重试',
  'debate.speaking': '正在发言',
  'debate.waiting': '○ 等待中',
  'debate.sideNote1': '立场随发言实时更新',
  'debate.sideNote2': '空格键 = 下一位',
  'debate.endSignal': '⚑ 结束信号',
  'debate.toVerdict': '听裁决 →',
  'debate.continue': '再聊聊',
  'debate.overtime': '加时一分钟',
  'debate.shift': (v: Vars) => `${v.name} 改变了立场：${v.from} → ${v.to}`,
  'debate.youInterjected': '你插话了',
  'debate.thinking': '圆桌思考中…',
  'debate.pausedForYou': '⏸ 已暂停，圆桌在等你说完',
  'debate.interjectPlaceholder': '说说你的想法……',
  'debate.send': '发送插话',
  'debate.cancel': '算了，继续吧',
  'debate.pause': '暂停',
  'debate.resume': '继续',
  'debate.pauseTitle': '暂停播放',
  'debate.next': '下一位',
  'debate.nextTitle': '空格键',
  'debate.interject': '我要插话',
  'debate.interjectNow': '（现在正好可以）',
  'debate.reqFailed': (v: Vars) => `接口请求失败（状态码 ${v.status}）`,
  'debate.closeFailed': (v: Vars) => `收尾请求失败（状态码 ${v.status}）`,
  'debate.connLost': '连接中断，请稍后重试',
  'debate.closeRetry': '收尾请求失败，请重试',
  'debate.listSep': '、',
  'banner.consensus': (v: Vars) => `三人都站到了「${v.side}」——提醒过有没有异议，没人反悔。这是共识。`,
  'banner.settled': (v: Vars) => `分歧已经清楚：${v.groups}。交过手了，连续两轮没人松口。`,
  'banner.settledGroup': (v: Vars) => `${v.names}「${v.side}」`,
  'banner.looping': (v: Vars) => `圆桌在绕圈：连续三轮没人改立场${v.pair ? `，${v.pair}也一直没正面交过手` : ''}。`,
  'banner.budget': (v: Vars) => `节目时间到了（${v.time}）。要现在听裁决吗？`,
  'banner.hardcap': '圆桌已经聊了 10 轮，该收尾了。',

  // closing
  'end.consensus': '三人达成共识',
  'end.settled': '分歧已经清楚',
  'end.looping': '圆桌开始绕圈',
  'end.budget': '节目时间到',
  'end.hardcap': '达到 10 轮上限',
  'end.user': '你喊了停',
  'closing.kicker': (v: Vars) => `TONIGHT'S VERDICT · 今夜裁决 · ${v.reason}`,
  'closing.unanimous': (v: Vars) => `一致：${v.side}`,
  'closing.leans': (v: Vars) => `${v.x} : ${v.y} 倾向「${v.side}」`,
  'closing.tie': '势均力敌',
  'closing.confidence': '信心',
  'closing.moved': (v: Vars) => `途中改过立场：${v.path}`,
  'closing.source': '出处 · 本场原话：',
  'closing.changeMind': '什么能让他改主意：',
  'closing.footnote': '圆桌不替你做决定。看看上面三条「什么能让他改主意」——哪一条在你身上成立，答案大概就在那边。',
  'closing.cardBrand': 'LATE-NIGHT RADIO · 圆桌',
  'closing.cardFooter': (v: Vars) => `今晚请 ${v.names} 辩论了我的问题`,
  'closing.save': '保存图片 ↓',
  'closing.saving': '生成中…',
  'closing.restart': '再开一场新的圆桌 ↻',
  'closing.fileName': '圆桌裁决卡.png',

  'doc.title': '圆桌 · 深夜辩论电台',
} satisfies Record<string, Entry | number>

type Key = keyof typeof zh

const en: { [K in Key]: (typeof zh)[K] extends (v: Vars) => string ? (v: Vars) => string : (typeof zh)[K] } = {
  'landing.kicker': 'LATE-NIGHT RADIO · A DEBATE SHOW',
  'landing.title': 'Roundtable',
  'landing.subtitle': '圆 桌 · LATE-NIGHT RADIO',
  'landing.pitch1': 'Write down a real-life question. Three historical minds',
  'landing.pitch2': 'pull up chairs at the table and debate it for you.',
  'landing.placeholder': "Write your question...\ne.g. 'Should I quit my job to do a PhD?' 'Lie low or stand out?'",
  'landing.tooShort': 'Give the table a little more to work with: at least 15 characters.',
  'landing.privacy': "Nothing is saved. The table exists for tonight only.",
  'landing.submit': 'Convene the table →',
  'landing.guests': "TONIGHT'S GUESTS · 8 ON STANDBY",
  'landing.minLen': 15,

  'motion.back': '← Edit question',
  'motion.yourQuestion': 'YOUR QUESTION',
  'motion.title': 'The Motion',
  'motion.desc': "To reach a verdict, the table needs an either/or. If it's off, just edit it. You're the host.",
  'motion.loading': 'Framing the motion…',
  'motion.retry': 'Retry',
  'motion.failed': (v: Vars) => `Couldn't frame the motion (status ${v.status})`,
  'motion.needsEdit': "Your question is long, so the motion couldn't be framed automatically. Shorten it and fill in sides A and B to start, or hit 'Reframe' to try again.",
  'motion.label': "TONIGHT'S MOTION",
  'motion.sideA': 'Side A',
  'motion.sideB': 'Side B',
  'motion.hint': "Guests may also go 'Conditional', but they have to name the condition. Who takes which side is up to them.",
  'motion.reframe': 'Reframe ↻',
  'motion.confirm': 'Debate this, pick guests →',

  'casting.back': '← Edit motion',
  'casting.motionLabel': "TONIGHT'S MOTION",
  'casting.title': 'Casting is the argument',
  'casting.desc': 'Pick 3 of 8. The mix of worldviews decides where the debate goes.',
  'casting.seated': '✓ Seated',
  'casting.count': (v: Vars) => `${v.n}/${v.max} seated`,
  'casting.needThree': 'Pick 3 guests',
  'casting.start': 'Start the debate →',
  'casting.sep': ' — ',

  'stance.mixed': 'Conditional',
  'stance.none': 'Undecided',

  'debate.preparing': 'Getting ready',
  'debate.round0': 'Round 0 · Openings',
  'debate.round': (v: Vars) => `Round ${v.n} · Clash`,
  'debate.closing': 'Preparing the verdict…',
  'debate.clockTitle': 'Show time: counts only while speeches play',
  'debate.endNow': "I've heard enough · Verdict",
  'debate.retry': 'Retry',
  'debate.speaking': 'Speaking',
  'debate.waiting': '○ Waiting',
  'debate.sideNote1': 'Sides update live as they speak',
  'debate.sideNote2': 'Space = next speaker',
  'debate.endSignal': '⚑ Ending signal',
  'debate.toVerdict': 'Hear the verdict →',
  'debate.continue': 'Keep going',
  'debate.overtime': 'One more minute',
  'debate.shift': (v: Vars) => `${v.name} switched sides: ${v.from} → ${v.to}`,
  'debate.youInterjected': 'You cut in',
  'debate.thinking': 'The table is thinking…',
  'debate.pausedForYou': '⏸ Paused. The table is waiting for you',
  'debate.interjectPlaceholder': "Say what you think...",
  'debate.send': 'Send',
  'debate.cancel': 'Never mind, go on',
  'debate.pause': 'Pause',
  'debate.resume': 'Resume',
  'debate.pauseTitle': 'Pause playback',
  'debate.next': 'Next',
  'debate.nextTitle': 'Space bar',
  'debate.interject': 'Cut in',
  'debate.interjectNow': ' (good moment now)',
  'debate.reqFailed': (v: Vars) => `Request failed (status ${v.status})`,
  'debate.closeFailed': (v: Vars) => `Verdict request failed (status ${v.status})`,
  'debate.connLost': 'Connection lost. Please retry.',
  'debate.closeRetry': 'Verdict request failed. Please retry.',
  'debate.listSep': ', ',
  'banner.consensus': (v: Vars) => `All three landed on '${v.side}'. They were nudged to object and nobody did. That's consensus.`,
  'banner.settled': (v: Vars) => `The disagreement is clear: ${v.groups}. They've clashed, and nobody has budged for two rounds.`,
  'banner.settledGroup': (v: Vars) => `${v.names} '${v.side}'`,
  'banner.looping': (v: Vars) => `The table is going in circles: no one has moved in three rounds${v.pair ? `, and ${v.pair} still haven't engaged each other` : ''}.`,
  'banner.budget': (v: Vars) => `Time's up (${v.time}). Hear the verdict now?`,
  'banner.hardcap': "Ten rounds in. Time to wrap up.",

  'end.consensus': 'Consensus reached',
  'end.settled': 'Disagreement is clear',
  'end.looping': 'Going in circles',
  'end.budget': "Time's up",
  'end.hardcap': '10-round limit',
  'end.user': 'You called it',
  'closing.kicker': (v: Vars) => `TONIGHT'S VERDICT · ${String(v.reason).toUpperCase()}`,
  'closing.unanimous': (v: Vars) => `Unanimous: ${v.side}`,
  'closing.leans': (v: Vars) => `${v.x} : ${v.y} for '${v.side}'`,
  'closing.tie': 'Dead even',
  'closing.confidence': 'Confidence',
  'closing.moved': (v: Vars) => `Switched along the way: ${v.path}`,
  'closing.source': 'Said tonight: ',
  'closing.changeMind': 'What would change their mind: ',
  'closing.footnote': "The table doesn't decide for you. Read the three 'what would change their mind' lines. Whichever one is true for you, that's probably where your answer is.",
  'closing.cardBrand': 'LATE-NIGHT RADIO · ROUNDTABLE',
  'closing.cardFooter': (v: Vars) => `Tonight ${v.names} debated my question`,
  'closing.save': 'Save image ↓',
  'closing.saving': 'Rendering…',
  'closing.restart': 'Start a new table ↻',
  'closing.fileName': 'roundtable-verdict.png',

  'doc.title': 'Roundtable · Late-Night Debate Radio',
}

const DICTS = { zh, en } as const

function initialLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang')
    if (q === 'en' || q === 'zh') return q
    const saved = window.localStorage.getItem('roundtable-lang')
    if (saved === 'en' || saved === 'zh') return saved
  } catch {
    // 某些嵌入环境里 localStorage 不可用，忽略即可
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

interface Ctx {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: Key, vars?: Vars) => string
  num: (key: Key) => number
  /** 引用一段文字：中文用「」，英文用 “” */
  q: (text: string) => string
}

const LangContext = createContext<Ctx | null>(null)

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try {
      window.localStorage.setItem('roundtable-lang', l)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    document.title = DICTS[lang]['doc.title']
  }, [lang])

  const value = useMemo<Ctx>(() => {
    const dict = DICTS[lang] as Record<Key, Entry | number>
    return {
      lang,
      setLang,
      t: (key, vars = {}) => {
        const e = dict[key]
        return typeof e === 'function' ? e(vars) : String(e)
      },
      num: (key) => Number(dict[key]),
      q: (text) => (lang === 'en' ? `“${text}”` : `「${text}」`),
    }
  }, [lang, setLang])

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n() {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useI18n must be used inside <LangProvider>')
  return ctx
}

export function LangSwitch({ className = '' }: { className?: string }) {
  const { lang, setLang } = useI18n()
  return (
    <div className={`inline-flex border-2 border-[var(--lc-ink)] font-mono-lc text-xs font-bold ${className}`} role="group" aria-label="Language">
      {(['zh', 'en'] as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          className={`px-2.5 py-1 ${lang === l ? 'bg-[var(--lc-ink)] text-[var(--lc-ivoire)]' : 'bg-[var(--lc-ivoire)] text-[var(--lc-ink)]'}`}
        >
          {l === 'zh' ? '中文' : 'EN'}
        </button>
      ))}
    </div>
  )
}
