import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Character } from '../data/characters'
import {
  STANCE_COLOR,
  stanceLabel,
  type DebateResult,
  type EndReason,
  type Ending,
  type HistoryEntry,
  type Motion,
  type Stance,
} from '../lib/debate'

export type { DebateResult }

interface Props {
  question: string
  motion: Motion
  chars: Character[]
  onEnd: (result: DebateResult) => void
}

interface Msg {
  id: number
  kind: 'char' | 'user' | 'banner' | 'shift'
  char?: Character
  text: string
  tag?: string
  stance?: Stance
  // banner 专用
  reason?: EndReason
  canContinue?: boolean
  resolved?: boolean
}

interface Speech extends HistoryEntry {
  tag: string
  shiftFrom: Stance | null
}

interface RoundData {
  round: number
  speeches: Speech[]
  privateMemory: Record<string, string[]>
  interjectionEntry: HistoryEntry | null
  ending: Ending
  hardCapped: boolean
  // 这一轮请求时注入了趋同提醒
  nudged: boolean
}

interface PlayItem {
  char: Character
  text: string
  tag: string
  stance: Stance
  shiftFrom: Stance | null
}

type FetchStatus = 'idle' | 'loading' | 'awaiting-user' | 'closing' | 'error'

// ---- 节奏：按阅读速度来，而不是按动画好看来 ----
// 中文正常阅读约每秒 5-8 字。打字约每秒 9 字，打完后再按字数留阅读时间，
// 一条 100 字的发言总共停留约 17 秒；读得快的人按「下一位 ▶」或空格跳过。
const TICK_MS = 50
const TYPE_MS_PER_CHAR = 110
const READ_MS_PER_CHAR = 60
const READ_MIN_MS = 2500
const READ_MAX_MS = 9000
// 每轮播完后的插话窗口（沿用之前的实测结论：6 秒）
const POST_ROUND_GRACE_MS = 6000
// 节目时长：只计"真正在播发言"的时间，不计等待模型、不计用户暂停
const BUDGET_MS = 5 * 60 * 1000
const OVERTIME_MS = 60 * 1000
// 用户在结束横幅上选了"再聊聊"之后，这么多轮之内不再弹同一种结局
const END_COOLDOWN_ROUNDS = 2

function readMs(len: number) {
  return Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, len * READ_MS_PER_CHAR))
}

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function DebateScreen({ question, motion, chars, onEnd }: Props) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [playQueue, setPlayQueue] = useState<PlayItem[]>([])
  const [currentItem, setCurrentItem] = useState<PlayItem | null>(null)
  const [shown, setShown] = useState('')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>('idle')
  const [input, setInput] = useState('')
  const [paused, setPaused] = useState(false)
  const [graceActive, setGraceActive] = useState(false)
  const [stances, setStances] = useState<Record<string, Stance>>({})
  const [playedRound, setPlayedRound] = useState<number | null>(null)
  const [clockMs, setClockMs] = useState(0)
  const [budgetMs, setBudgetMs] = useState(BUDGET_MS)

  const feedRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(0)
  const charById = useMemo(() => new Map(chars.map((c) => [c.id, c])), [chars])

  // ---- 会话状态：只有"被采用（开始播放）"的轮次才并入 history ----
  const historyRef = useRef<HistoryEntry[]>([])
  const privateMemoryRef = useRef<Record<string, string[]>>({})
  const currentRoundRef = useRef<RoundData | null>(null) // 正在播/刚播完的这一轮
  const bufferRef = useRef<RoundData | null>(null) // 预取好的下一轮，还没开始播
  const inflightRef = useRef<{ round: number; controller: AbortController } | null>(null)
  const playWhenArrivesRef = useRef(false) // 播放已经追上，下一轮一到就直接播
  const pendingInterjectionRef = useRef<string | null>(null)
  const nudgeRoundRef = useRef<number | null>(null)
  const endCooldownUntilRef = useRef(-1)
  const budgetRef = useRef(BUDGET_MS)
  const budgetBannerShownRef = useRef(false)
  const endedRef = useRef(false)
  const closingControllerRef = useRef<AbortController | null>(null)

  const pausedRef = useRef(false)
  const interjectionPausedRef = useRef(false)
  const [interjectionMode, setInterjectionMode] = useState(false)
  const [resumeTick, setResumeTick] = useState(0)

  // 打字/阅读进度：elapsed 只在未暂停时前进，同时累加到节目时钟
  const elapsedRef = useRef(0)
  const clockRef = useRef(0)

  // ---------------- 播放 ----------------

  useEffect(() => {
    if (currentItem) return
    if (playQueue.length === 0) return
    const [item, ...rest] = playQueue
    elapsedRef.current = 0
    setShown('')
    setCurrentItem(item)
    setPlayQueue(rest)
  }, [playQueue, currentItem])

  const finishItem = useCallback(
    (item: PlayItem) => {
      setMessages((m) => {
        const next: Msg[] = [
          ...m,
          { id: ++idRef.current, kind: 'char', char: item.char, text: item.text, tag: item.tag, stance: item.stance },
        ]
        if (item.shiftFrom) {
          next.push({
            id: ++idRef.current,
            kind: 'shift',
            char: item.char,
            text: `${item.char.name} 改变了立场：${stanceLabel(motion, item.shiftFrom)} → ${stanceLabel(motion, item.stance)}`,
            stance: item.stance,
          })
        }
        return next
      })
      setStances((s) => ({ ...s, [item.char.id]: item.stance }))
      setCurrentItem(null)
      setShown('')
    },
    [motion],
  )

  useEffect(() => {
    if (!currentItem) return
    const typeMs = currentItem.text.length * TYPE_MS_PER_CHAR
    const totalMs = typeMs + readMs(currentItem.text.length)
    const timer = setInterval(() => {
      if (pausedRef.current) return
      elapsedRef.current += TICK_MS
      clockRef.current += TICK_MS
      const n = Math.min(currentItem.text.length, Math.floor(elapsedRef.current / TYPE_MS_PER_CHAR))
      setShown(currentItem.text.slice(0, n))
      if (elapsedRef.current % 1000 < TICK_MS) setClockMs(clockRef.current)
      if (elapsedRef.current >= totalMs) {
        clearInterval(timer)
        setClockMs(clockRef.current)
        finishItem(currentItem)
      }
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [currentItem, finishItem])

  // 「下一位 ▶」：还在打字 → 直接显示全文进入阅读；已经在阅读 → 立刻下一位
  const skip = useCallback(() => {
    if (!currentItem) return
    const typeMs = currentItem.text.length * TYPE_MS_PER_CHAR
    if (elapsedRef.current < typeMs) {
      elapsedRef.current = typeMs
      setShown(currentItem.text)
    } else {
      finishItem(currentItem)
    }
  }, [currentItem, finishItem])

  const togglePause = useCallback(() => {
    pausedRef.current = !pausedRef.current
    setPaused(pausedRef.current)
    if (!pausedRef.current) setResumeTick((n) => n + 1)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        skip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [skip])

  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, shown])

  // ---------------- 请求 ----------------

  const requestRound = async (round: number): Promise<RoundData | null> => {
    const controller = new AbortController()
    inflightRef.current = { round, controller }
    const interjection = pendingInterjectionRef.current
    const nudge = nudgeRoundRef.current === null && !!currentRoundRef.current?.ending.needNudge
    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 'debate',
          question,
          motion,
          characterIds: chars.map((c) => c.id),
          round,
          history: historyRef.current,
          privateMemory: privateMemoryRef.current,
          interjection: interjection ?? undefined,
          nudge,
          nudgeRound: nudgeRoundRef.current,
        }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `接口请求失败（状态码 ${res.status}）`)
      if (inflightRef.current?.controller !== controller) return null // 已被丢弃
      inflightRef.current = null
      if (interjection) pendingInterjectionRef.current = null
      return { round, ...data, nudged: nudge }
    } catch (err) {
      if (inflightRef.current?.controller === controller) inflightRef.current = null
      if ((err as Error).name === 'AbortError') return null
      setConnectionError((err as Error).message || '连接中断，请稍后重试')
      setFetchStatus('error')
      return null
    }
  }

  // 采用一轮：并入 history、放进播放队列、然后立刻预取下一轮（趁用户读的时候生成）
  const acceptRound = (data: RoundData) => {
    if (data.nudged) nudgeRoundRef.current = data.round
    const entries: HistoryEntry[] = [
      ...(data.interjectionEntry ? [data.interjectionEntry] : []),
      ...data.speeches.map((s) => ({
        charId: s.charId,
        name: s.name,
        text: s.text,
        round: s.round,
        stance: s.stance,
        confidence: s.confidence,
        responseType: s.responseType,
        target: s.target,
        changeMind: s.changeMind,
      })),
    ]
    historyRef.current = [...historyRef.current, ...entries]
    privateMemoryRef.current = data.privateMemory
    currentRoundRef.current = data
    setPlayedRound(data.round)
    setPlayQueue((q) => [
      ...q,
      ...data.speeches
        .map((s) => {
          const char = charById.get(s.charId)
          return char ? { char, text: s.text, tag: s.tag, stance: (s.stance ?? 'MIXED') as Stance, shiftFrom: s.shiftFrom } : null
        })
        .filter(Boolean) as PlayItem[],
    ])
    setFetchStatus('idle')
    if (!data.ending.endType && !data.hardCapped) prefetch(data.round + 1)
  }

  const prefetch = async (round: number) => {
    if (inflightRef.current || bufferRef.current || endedRef.current) return
    const data = await requestRound(round)
    if (!data) return
    if (playWhenArrivesRef.current && !interjectionPausedRef.current) {
      playWhenArrivesRef.current = false
      acceptRound(data)
    } else {
      bufferRef.current = data
    }
  }

  // 播放下一轮：有预取就直接播；在路上就等它；都没有就现请求
  const playNext = () => {
    const cur = currentRoundRef.current
    const nextRound = (cur?.round ?? -1) + 1
    if (bufferRef.current) {
      const b = bufferRef.current
      bufferRef.current = null
      acceptRound(b)
      return
    }
    setFetchStatus('loading')
    playWhenArrivesRef.current = true
    if (!inflightRef.current) prefetch(nextRound)
  }

  // 插话会让预取好的下一轮作废：它是在用户说话之前生成的
  const discardPrefetch = () => {
    bufferRef.current = null
    inflightRef.current?.controller.abort()
    inflightRef.current = null
  }

  const fetchClosing = async (endReason: EndReason) => {
    if (endedRef.current) return
    discardPrefetch()
    setFetchStatus('closing')
    const controller = new AbortController()
    closingControllerRef.current = controller
    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 'closing',
          question,
          motion,
          characterIds: chars.map((c) => c.id),
          history: historyRef.current,
        }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `收尾请求失败（状态码 ${res.status}）`)
      if (endedRef.current) return
      endedRef.current = true
      onEnd({ advice: data.advice ?? [], verdict: data.verdict ?? [], endReason })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setConnectionError((err as Error).message || '收尾请求失败，请重试')
      setFetchStatus('error')
    }
  }

  useEffect(() => {
    ;(async () => {
      setFetchStatus('loading')
      const data = await requestRound(0)
      if (data) acceptRound(data)
    })()
    return () => {
      inflightRef.current?.controller.abort()
      closingControllerRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------- 结束标准 → 横幅文案 ----------------

  const names = (ids: string[]) => ids.map((id) => charById.get(id)?.name ?? id).join('、')

  const endBannerText = (reason: EndReason, ending: Ending | null): string => {
    if (reason === 'consensus' && ending) {
      const s = ending.stances[chars[0].id]
      return `三人都站到了「${stanceLabel(motion, s)}」——提醒过有没有异议，没人反悔。这是共识。`
    }
    if (reason === 'settled' && ending) {
      const groups = (['A', 'B', 'MIXED'] as Stance[])
        .map((st) => ({ st, ids: chars.map((c) => c.id).filter((id) => ending.stances[id] === st) }))
        .filter((g) => g.ids.length)
        .map((g) => `${names(g.ids)}「${stanceLabel(motion, g.st)}」`)
      return `分歧已经清楚：${groups.join(' vs ')}。交过手了，连续两轮没人松口。`
    }
    if (reason === 'looping' && ending) {
      const pair = ending.unengagedPairs[0]
      return `圆桌在绕圈：连续三轮没人改立场${pair ? `，${names(pair)}也一直没正面交过手` : ''}。`
    }
    if (reason === 'budget') return `节目时间到了（${fmt(budgetRef.current)}）。要现在听裁决吗？`
    return '圆桌已经聊了 10 轮，该收尾了。'
  }

  const pushBanner = (reason: EndReason, canContinue: boolean) => {
    setMessages((m) => [
      ...m,
      { id: ++idRef.current, kind: 'banner', reason, text: endBannerText(reason, currentRoundRef.current?.ending ?? null), canContinue },
    ])
  }

  // ---------------- watcher：一轮播完后决定下一步 ----------------
  useEffect(() => {
    if (playQueue.length > 0 || currentItem) return
    if (fetchStatus !== 'idle') return
    if (interjectionPausedRef.current || pausedRef.current) return
    const cur = currentRoundRef.current
    if (!cur) return

    const decide = () => {
      if (cur.hardCapped) {
        pushBanner('hardcap', false)
        fetchClosing('hardcap')
        return
      }
      const endType = cur.ending.endType
      if (endType && cur.round > endCooldownUntilRef.current) {
        pushBanner(endType, true)
        setFetchStatus('awaiting-user')
        return
      }
      if (clockRef.current >= budgetRef.current && !budgetBannerShownRef.current) {
        budgetBannerShownRef.current = true
        pushBanner('budget', true)
        setFetchStatus('awaiting-user')
        return
      }
      playNext()
    }

    // 用户刚插完话：不再等插话窗口、也不先弹结束信号，马上让圆桌回应
    if (pendingInterjectionRef.current) {
      playNext()
      return
    }

    // 每轮播完后留固定的插话窗口，跟这轮发言长短无关
    setGraceActive(true)
    const timer = setTimeout(() => {
      setGraceActive(false)
      if (interjectionPausedRef.current || pausedRef.current) return
      decide()
    }, POST_ROUND_GRACE_MS)
    return () => {
      clearTimeout(timer)
      setGraceActive(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playQueue, currentItem, fetchStatus, resumeTick])

  // ---------------- 用户操作 ----------------

  const resolveBanner = (bannerId: number) =>
    setMessages((m) => m.map((msg) => (msg.id === bannerId ? { ...msg, resolved: true } : msg)))

  const handleBannerContinue = (msg: Msg) => {
    resolveBanner(msg.id)
    const cur = currentRoundRef.current
    if (msg.reason === 'budget') {
      budgetRef.current = clockRef.current + OVERTIME_MS
      setBudgetMs(budgetRef.current)
      budgetBannerShownRef.current = false
    } else if (cur) {
      endCooldownUntilRef.current = cur.round + END_COOLDOWN_ROUNDS
    }
    setFetchStatus('idle')
    playNext()
  }

  const handleBannerEnd = (msg: Msg) => {
    resolveBanner(msg.id)
    fetchClosing(msg.reason ?? 'user')
  }

  const handleEnd = () => fetchClosing('user')

  const handleRetry = () => {
    setConnectionError(null)
    if (fetchStatus !== 'error') return
    if (!currentRoundRef.current) {
      setFetchStatus('loading')
      requestRound(0).then((d) => d && acceptRound(d))
    } else {
      setFetchStatus('idle')
      playNext()
    }
  }

  const sendInterjection = () => {
    const t = input.trim()
    if (!t) return
    setMessages((m) => [...m, { id: ++idRef.current, kind: 'user', text: t }])
    pendingInterjectionRef.current = t
    discardPrefetch()
    setInput('')
    interjectionPausedRef.current = false
    setInterjectionMode(false)
    setResumeTick((n) => n + 1)
  }

  const openInterjection = () => {
    interjectionPausedRef.current = true
    setInterjectionMode(true)
  }

  const cancelInterjection = () => {
    interjectionPausedRef.current = false
    setInterjectionMode(false)
    setInput('')
    // 预取的下一轮如果在等待期间到了、放在了 buffer 里，继续正常播
    setResumeTick((n) => n + 1)
  }

  // ---------------- 渲染 ----------------

  const roundLabel =
    fetchStatus === 'closing'
      ? '正在整理裁决…'
      : playedRound === null
        ? '准备开场'
        : playedRound === 0
          ? '第 0 轮 · 开场'
          : `第 ${playedRound} 轮 · 交锋`

  const speakingId = currentItem?.char.id ?? null
  const budgetPct = Math.min(100, (clockMs / budgetMs) * 100)

  const StanceChip = ({ s, small }: { s?: Stance; small?: boolean }) =>
    s ? (
      <span
        className={`font-mono-lc ${small ? 'text-[9px] px-1' : 'text-[10px] px-1.5'} py-px border font-bold text-[var(--lc-ivoire)] whitespace-nowrap`}
        style={{ background: STANCE_COLOR[s], borderColor: STANCE_COLOR[s] }}
      >
        {s === 'MIXED' ? '有条件' : `${s}·${stanceLabel(motion, s)}`}
      </span>
    ) : (
      <span className={`font-mono-lc ${small ? 'text-[9px]' : 'text-[10px]'} text-[var(--lc-ombre)]`}>未表态</span>
    )

  return (
    <div className="screen-in h-full flex flex-col">
      <div className="border-b-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire)] shrink-0">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="font-mono-lc text-xs md:text-sm font-bold border-2 border-[var(--lc-ink)] bg-[var(--lc-ocre)] px-2.5 py-1 shrink-0">
            {roundLabel}
          </span>
          <div className="flex-1 min-w-0 hidden sm:block">
            <div className="text-sm font-medium truncate" title={question}>
              「{motion.motion}」
            </div>
            <div className="font-mono-lc text-[10px] truncate">
              <span style={{ color: STANCE_COLOR.A }}>A·{motion.a}</span>
              <span className="text-[var(--lc-ombre)]"> vs </span>
              <span style={{ color: STANCE_COLOR.B }}>B·{motion.b}</span>
            </div>
          </div>
          <div className="hidden md:flex flex-col items-end gap-1 shrink-0 w-28" title="节目时长：只计发言播放的时间">
            <span className="font-mono-lc text-[10px] text-[var(--lc-ombre)]">
              {fmt(clockMs)} / {fmt(budgetMs)}
            </span>
            <div className="w-full h-1.5 border border-[var(--lc-ink)] bg-[var(--lc-ivoire-2)]">
              <div className="h-full bg-[var(--lc-vermillon)] transition-all" style={{ width: `${budgetPct}%` }} />
            </div>
          </div>
          <button onClick={handleEnd} className="lc-btn lc-btn-vermillon px-3 py-1.5 text-sm shrink-0">
            我已有答案 · 听裁决
          </button>
        </div>
      </div>

      {connectionError && (
        <div className="max-w-6xl mx-auto w-full px-4 pt-3">
          <div className="border-2 border-[var(--lc-vermillon)] bg-[var(--lc-vermillon)]/10 px-4 py-2 text-sm flex items-center justify-between gap-3">
            <span>{connectionError}</span>
            <button onClick={handleRetry} className="lc-btn lc-btn-outremer px-3 py-1 text-xs shrink-0">
              重试
            </button>
          </div>
        </div>
      )}

      {/* 手机端：侧栏隐藏，把三人当前立场压成一行 */}
      <div className="md:hidden max-w-6xl mx-auto w-full px-4 pt-3 flex gap-2 overflow-x-auto">
        {chars.map((c) => (
          <div key={c.id} className="flex items-center gap-1.5 border-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire-2)] px-2 py-1 shrink-0">
            <img src={c.avatar} alt={c.name} className="pixelated w-6 h-6" />
            <StanceChip s={stances[c.id]} small />
          </div>
        ))}
      </div>

      <div className="flex-1 min-h-0 max-w-6xl mx-auto w-full px-4 py-4 flex gap-4">
        <div className="hidden md:flex flex-col gap-3 w-56 shrink-0">
          {chars.map((c) => {
            const speaking = speakingId === c.id
            return (
              <div
                key={c.id}
                className="border-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire-2)] p-3 flex items-center gap-3 transition-shadow"
                style={{ boxShadow: speaking ? `4px 4px 0 ${c.color}` : '2px 2px 0 var(--lc-ink)' }}
              >
                <div
                  className="w-12 h-12 border-2 shrink-0 overflow-hidden bg-[var(--lc-ivoire)]"
                  style={{ borderColor: speaking ? c.color : 'var(--lc-ink)' }}
                >
                  <img src={c.avatar} alt={c.name} className="pixelated w-full h-full object-cover" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="font-bold text-sm">{c.name}</div>
                  <StanceChip s={stances[c.id]} />
                  {speaking ? (
                    <div className="font-mono-lc text-[10px] flex items-center gap-1" style={{ color: c.color }}>
                      <span className="pulse-dot">●</span> 正在发言
                    </div>
                  ) : (
                    <div className="font-mono-lc text-[10px] text-[var(--lc-ombre)]">○ 等待中</div>
                  )}
                </div>
              </div>
            )
          })}
          <div className="font-mono-lc text-[10px] text-[var(--lc-ombre)] leading-relaxed mt-auto">
            立场随发言实时更新
            <br />
            空格键 = 下一位
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div ref={feedRef} className="lc-scroll flex-1 min-h-0 overflow-y-auto pr-1 space-y-4 pb-2">
            {messages.map((m) => {
              if (m.kind === 'banner') {
                if (m.resolved) return null
                return (
                  <div key={m.id} className="msg-in border-2 border-[var(--lc-ink)] bg-[var(--lc-ocre)] px-4 py-3 flex items-center gap-3 flex-wrap">
                    <span className="font-mono-lc text-xs font-bold shrink-0">⚑ 结束信号</span>
                    <span className="text-sm flex-1 min-w-[200px]">{m.text}</span>
                    <div className="flex gap-2">
                      <button onClick={() => handleBannerEnd(m)} className="lc-btn lc-btn-outremer px-3 py-1.5 text-sm">
                        听裁决 →
                      </button>
                      {m.canContinue && (
                        <button onClick={() => handleBannerContinue(m)} className="lc-btn lc-btn-ivoire px-3 py-1.5 text-sm">
                          {m.reason === 'budget' ? '加时一分钟' : '再聊聊'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              }

              if (m.kind === 'shift') {
                return (
                  <div key={m.id} className="msg-in flex justify-center">
                    <div
                      className="font-mono-lc text-xs font-bold border-2 px-3 py-1.5 bg-[var(--lc-ivoire)]"
                      style={{ borderColor: m.stance ? STANCE_COLOR[m.stance] : 'var(--lc-ink)' }}
                    >
                      ⇄ {m.text}
                    </div>
                  </div>
                )
              }

              if (m.kind === 'user') {
                return (
                  <div key={m.id} className="msg-in flex justify-end">
                    <div className="max-w-[85%] border-2 border-[var(--lc-ceruleen)] bg-[var(--lc-ceruleen)]/10 px-4 py-3">
                      <div className="font-mono-lc text-[10px] text-[var(--lc-ceruleen)] font-bold mb-1">你插话了</div>
                      <p className="font-pixel-cn text-xs" style={{ lineHeight: 1.9 }}>
                        {m.text}
                      </p>
                    </div>
                  </div>
                )
              }

              return (
                <div key={m.id} className="msg-in flex gap-3">
                  <div className="w-10 h-10 border-2 shrink-0 overflow-hidden bg-[var(--lc-ivoire-2)]" style={{ borderColor: m.char!.color }}>
                    <img src={m.char!.avatar} alt={m.char!.name} className="pixelated w-full h-full object-cover" />
                  </div>
                  <div className="lc-card-flat max-w-[85%] px-4 py-3">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-bold text-sm" style={{ color: m.char!.color }}>
                        {m.char!.name}
                      </span>
                      {m.tag && (
                        <span className="font-mono-lc text-[10px] border border-[var(--lc-ink)] px-1.5 py-px bg-[var(--lc-ivoire)]">{m.tag}</span>
                      )}
                      <StanceChip s={m.stance} small />
                    </div>
                    <p className="font-pixel-cn text-xs" style={{ lineHeight: 1.9 }}>
                      {m.text}
                    </p>
                  </div>
                </div>
              )
            })}

            {currentItem && (
              <div className="flex gap-3">
                <div className="w-10 h-10 border-2 shrink-0 overflow-hidden bg-[var(--lc-ivoire-2)]" style={{ borderColor: currentItem.char.color }}>
                  <img src={currentItem.char.avatar} alt={currentItem.char.name} className="pixelated w-full h-full object-cover" />
                </div>
                <div className="lc-card-flat max-w-[85%] px-4 py-3">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-bold text-sm" style={{ color: currentItem.char.color }}>
                      {currentItem.char.name}
                    </span>
                    <span className="font-mono-lc text-[10px] border border-[var(--lc-ink)] px-1.5 py-px bg-[var(--lc-ivoire)]">{currentItem.tag}</span>
                  </div>
                  <p className={`font-pixel-cn text-xs ${shown.length < currentItem.text.length ? 'type-cursor' : ''}`} style={{ lineHeight: 1.9 }}>
                    {shown}
                  </p>
                </div>
              </div>
            )}

            {fetchStatus === 'loading' && playQueue.length === 0 && !currentItem && (
              <div className="font-mono-lc text-xs text-[var(--lc-ombre)] flex items-center gap-2 px-1">
                <span className="pulse-dot">●</span> 圆桌思考中…
              </div>
            )}
          </div>

          <div className="shrink-0 pb-1">
            {interjectionMode ? (
              <div className="flex flex-col gap-2">
                <div className="font-mono-lc text-[10px] text-[var(--lc-ceruleen)] font-bold">⏸ 已暂停，圆桌在等你说完</div>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendInterjection()}
                    placeholder="说说你的想法……"
                    className="flex-1 min-w-0 bg-[var(--lc-ivoire-2)] border-2 border-[var(--lc-ceruleen)] px-4 py-3 text-sm outline-none placeholder:text-[var(--lc-ombre)]"
                  />
                  <button onClick={sendInterjection} className="lc-btn lc-btn-outremer px-5 py-3 text-sm shrink-0">
                    发送插话
                  </button>
                  <button onClick={cancelInterjection} className="lc-btn lc-btn-ivoire px-4 py-3 text-sm shrink-0">
                    算了，继续吧
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={togglePause}
                  disabled={fetchStatus === 'closing'}
                  className="lc-btn lc-btn-ivoire px-3 sm:px-4 py-3 text-sm shrink-0 disabled:opacity-40"
                  title="暂停播放"
                >
                  {paused ? '▶' : '❚❚'}<span className="hidden sm:inline"> {paused ? '继续' : '暂停'}</span>
                </button>
                <button
                  onClick={skip}
                  disabled={!currentItem}
                  className="lc-btn lc-btn-ivoire px-4 py-3 text-sm shrink-0 disabled:opacity-40"
                  title="空格键"
                >
                  <span className="hidden sm:inline">下一位 </span>▶
                </button>
                <button
                  onClick={openInterjection}
                  disabled={fetchStatus === 'closing'}
                  className={`lc-btn flex-1 py-3 text-sm disabled:opacity-40 transition-colors ${graceActive ? 'lc-btn-vermillon' : 'lc-btn-outremer'}`}
                >
                  我要插话{graceActive && <span className="hidden sm:inline">（现在正好可以）</span>}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
