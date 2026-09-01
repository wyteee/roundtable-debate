import { useEffect, useMemo, useRef, useState } from 'react'
import type { Character } from '../data/characters'

// 真实辩论结束后要传给收尾屏的数据：每个角色一句基于本场对话生成的忠告
export interface DebateResult {
  advice: { charId: string; text: string }[]
}

interface Props {
  question: string
  chars: Character[]
  onEnd: (result: DebateResult) => void
}

interface Msg {
  id: number
  kind: 'char' | 'user' | 'banner'
  char?: Character
  text: string
  tag?: string
  // 只有banner用：这条横幅是否提供"再聊聊"选项（硬上限时不提供）、
  // 以及这条横幅是否已经被用户处理过（点过按钮之后不再显示按钮，避免重复触发）
  canContinue?: boolean
  resolved?: boolean
}

// 对应后端 api/debate.js 的历史发言记录格式（跟request/response里的history字段一致）
interface HistoryEntry {
  charId: string
  name: string
  text: string
}

interface PlayItem {
  char: Character
  text: string
  tag: string
}

// 每轮请求成功后返回的、影响"接下来该做什么"的关键信息
interface RoundResult {
  suggestEnd: boolean
  bannerText?: string
  hardCapped: boolean
}

// 请求状态机：
// idle          - 没有请求在跑，watcher effect会根据lastRoundResult决定下一步做什么
// loading       - 正在请求下一轮
// awaiting-user - 已经显示了"建议收尾"横幅，等用户点"再聊聊"或"去收尾"
// closing       - 正在请求收尾高光
// error         - 上一次请求失败，等用户手动重试，不会自动继续
type FetchStatus = 'idle' | 'loading' | 'awaiting-user' | 'closing' | 'error'

// ---- 打字/阅读节奏相关的可调常量 ----
const TYPE_MS_PER_CHAR = 45
const READ_PAUSE_BASE_MS = 1400
const READ_PAUSE_PER_CHAR_MS = 35
const READ_PAUSE_MAX_MS = 3600
// 每一轮的3条发言全部播完之后，不管这轮发言本身有多长/多短，都额外留这么久
// 的固定缓冲期，专门用来给用户反应"要不要点我要插话"——之前没有这个独立的缓冲，
// 完全依附在"这轮发言播放要多久"上，发言越短窗口就越短，跟用户有没有点按钮无关，
// 纯粹是时间窗口本身在缩水，容易出现"点了也来不及"的情况。
// 原本设成3秒，实测反馈太短，调到6秒。
const POST_ROUND_GRACE_MS = 6000

export default function DebateScreen({ question, chars, onEnd }: Props) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [playQueue, setPlayQueue] = useState<PlayItem[]>([])
  const [typing, setTyping] = useState<(PlayItem & { shown: string }) | null>(null)
  const [currentItem, setCurrentItem] = useState<PlayItem | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [fetchStatus, setFetchStatus] = useState<FetchStatus>('idle')
  const [input, setInput] = useState('')

  // 缓冲期是否正在进行中，只用来给按钮加一点视觉提示，不参与任何逻辑判断
  const [graceActive, setGraceActive] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const feedCountRef = useRef(0)
  const idRef = useRef(0) // 消息的唯一id生成器，之前不小心漏掉了声明，只留了使用
  const charById = useMemo(() => new Map(chars.map((c) => [c.id, c])), [chars])
  const abortControllerRef = useRef<AbortController | null>(null)

  // ---- 方案A的核心状态：不再由后端记忆，改成前端自己攒着，每次请求完整传回去 ----
  const historyRef = useRef<HistoryEntry[]>([])
  const privateMemoryRef = useRef<Record<string, string[]>>({})
  const nextRoundRef = useRef(0) // 下一次该请求第几轮
  const pendingInterjectionRef = useRef<string | null>(null) // 待发送、还没被下一轮消费的插话
  const lastRoundResultRef = useRef<RoundResult | null>(null)
  const endedRef = useRef(false) // 防止onEnd被重复调用

  // ---- 插话相关：从"输入框一直开着、机会性地被下一次自动请求捡走"，
  // 改成"点按钮显式暂停整个自动推进流程，直到用户提交或放弃"----
  // interjectionPausedRef为true期间，下面的watcher effect完全不做任何决定
  // （不自动请求下一轮、也不弹报警器横幅），哪怕这时候恰好有一轮已经播完了。
  // 用一个ref而不是state，是因为它只被内部逻辑读取判断，不直接参与渲染。
  const interjectionPausedRef = useRef(false)
  const [interjectionMode, setInterjectionMode] = useState(false)
  // 每次用户提交/放弃插话后+1，强制下面的watcher effect重新跑一次判断
  // （因为effect依赖数组里放的是state，光改一个ref不会触发effect重新执行）
  const [resumeTick, setResumeTick] = useState(0)

  // ---- 出队effect：跟原来一样，队列有内容且当前没在播时，挪一条到currentItem ----
  useEffect(() => {
    if (currentItem) return
    if (playQueue.length === 0) return
    const [item, ...rest] = playQueue
    setCurrentItem(item)
    setPlayQueue(rest)
  }, [playQueue, currentItem])

  // ---- 打字动画effect：跟原来一样 ----
  useEffect(() => {
    if (!currentItem) return
    let i = 0
    const timer = setInterval(() => {
      i++
      setTyping({ ...currentItem, shown: currentItem.text.slice(0, i) })
      if (i >= currentItem.text.length) {
        clearInterval(timer)
        const pause = Math.min(
          READ_PAUSE_MAX_MS,
          READ_PAUSE_BASE_MS + currentItem.text.length * READ_PAUSE_PER_CHAR_MS
        )
        setTimeout(() => {
          setTyping(null)
          feedCountRef.current += 1
          setMessages((m) => [
            ...m,
            { id: ++idRef.current, kind: 'char', char: currentItem.char, text: currentItem.text, tag: currentItem.tag },
          ])
          setCurrentItem(null)
        }, pause)
      }
    }, TYPE_MS_PER_CHAR)

    return () => clearInterval(timer)
  }, [currentItem])

  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, typing])

  // ---- 请求某一轮的发言 ----
  const fetchRound = async (round: number) => {
    setFetchStatus('loading')
    const controller = new AbortController()
    abortControllerRef.current = controller

    // 插话消费一次：这次请求带上去之后就清空，不管这轮实际有没有用到，
    // 避免同一句插话被反复带进后面好几轮请求里
    const interjectionToSend = pendingInterjectionRef.current ?? undefined
    pendingInterjectionRef.current = null

    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          characterIds: chars.map((c) => c.id),
          round,
          history: historyRef.current,
          privateMemory: privateMemoryRef.current,
          interjection: interjectionToSend,
          phase: 'debate',
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setConnectionError(body.error || `接口请求失败（状态码 ${res.status}）`)
        setFetchStatus('error')
        // 请求失败，插话没有真正被消费，放回去，重试的时候还能带上
        if (interjectionToSend) pendingInterjectionRef.current = interjectionToSend
        return
      }

      const data = await res.json()

      // 如果这轮消费了用户插话，后端会额外返回一条"你"说的历史记录，
      // 需要按时间顺序插在这轮发言之前，让插话真正留在对话记录里、
      // 影响未来所有轮次的上下文，而不是只在这一轮里昙花一现。
      const interjectionHistoryEntry: HistoryEntry[] = data.interjectionEntry
        ? [{ charId: data.interjectionEntry.charId, name: data.interjectionEntry.name, text: data.interjectionEntry.text }]
        : []

      historyRef.current = [
        ...historyRef.current,
        ...interjectionHistoryEntry,
        ...data.speeches.map((s: { charId: string; name: string; text: string }) => ({
          charId: s.charId,
          name: s.name,
          text: s.text,
        })),
      ]
      privateMemoryRef.current = data.privateMemory

      const newItems: PlayItem[] = data.speeches
        .map((s: { charId: string; text: string; tag: string }) => {
          const char = charById.get(s.charId)
          if (!char) return null
          return { char, text: s.text, tag: s.tag }
        })
        .filter(Boolean)
      setPlayQueue((q) => [...q, ...newItems])

      lastRoundResultRef.current = {
        suggestEnd: data.suggestEnd,
        bannerText: data.bannerText,
        hardCapped: data.hardCapped,
      }
      nextRoundRef.current = round + 1
      setFetchStatus('idle') // 交给下面的watcher effect，等播放追上了再决定下一步
    } catch (err) {
      if ((err as Error).name === 'AbortError') return // 用户主动结束，静默忽略
      setConnectionError('连接中断，请稍后重试')
      setFetchStatus('error')
      if (interjectionToSend) pendingInterjectionRef.current = interjectionToSend
    }
  }

  // ---- 请求收尾高光，成功后调用onEnd跳转 ----
  const fetchClosing = async () => {
    if (endedRef.current) return
    setFetchStatus('closing')
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          characterIds: chars.map((c) => c.id),
          history: historyRef.current,
          phase: 'closing',
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setConnectionError(body.error || `收尾请求失败（状态码 ${res.status}）`)
        setFetchStatus('error')
        return
      }

      const data = await res.json()
      if (endedRef.current) return
      endedRef.current = true
      onEnd({ advice: data.advice ?? [] })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setConnectionError('收尾请求失败，请重试')
      setFetchStatus('error')
    }
  }

  // ---- 组件挂载时，请求第0轮（开场） ----
  useEffect(() => {
    fetchRound(0)
    return () => abortControllerRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- watcher effect：播放追上了（队列空、当前没在播）且没有请求在跑时，
  // 根据上一轮的结果决定接下来做什么：
  //   - hardCapped：直接强制进入收尾，不再给"继续"选项
  //   - suggestEnd（未到硬上限）：把横幅加进消息流，等用户点按钮
  //   - 都不是：自动请求下一轮
  // 这个时机判断比原来SSE版本更准确——原来banner是"数据一到就立刻显示"，
  // 可能显示在还没播完的发言前面；现在banner只在真正播放追上之后才出现。----
  // ---- watcher effect：播放追上了（队列空、当前没在播）且没有请求在跑时，
  // 先固定等待POST_ROUND_GRACE_MS这么久（给用户留出点"我要插话"的窗口），
  // 缓冲期结束时再检查一次有没有被暂停——如果用户在缓冲期内点了按钮，
  // interjectionPausedRef会变成true，到时候直接放弃这次自动推进。
  // 缓冲期本身跟这轮发言多长完全无关，保证每轮都有同样长的反应时间。
  // 缓冲期过后，根据上一轮的结果决定接下来做什么：
  //   - hardCapped：直接强制进入收尾，不再给"继续"选项
  //   - suggestEnd（未到硬上限）：把横幅加进消息流，等用户点按钮
  //   - 都不是：自动请求下一轮
  useEffect(() => {
    if (playQueue.length > 0) return
    if (currentItem) return
    if (fetchStatus !== 'idle') return
    if (interjectionPausedRef.current) return // 已经点了暂停，缓冲期都不用等了
    const result = lastRoundResultRef.current
    if (!result) return // 还没有任何一轮结果，说明第0轮还没回来，不用管

    setGraceActive(true)
    const timer = setTimeout(() => {
      // 缓冲期结束时再查一次——用户可能就是在这几秒里点的"我要插话"
      setGraceActive(false)
      if (interjectionPausedRef.current) return

      if (result.hardCapped) {
        lastRoundResultRef.current = null
        setMessages((m) => [
          ...m,
          { id: ++idRef.current, kind: 'banner', text: result.bannerText ?? '', canContinue: false },
        ])
        fetchClosing()
      } else if (result.suggestEnd) {
        lastRoundResultRef.current = null
        setMessages((m) => [
          ...m,
          { id: ++idRef.current, kind: 'banner', text: result.bannerText ?? '', canContinue: true },
        ])
        setFetchStatus('awaiting-user')
      } else {
        lastRoundResultRef.current = null
        fetchRound(nextRoundRef.current)
      }
    }, POST_ROUND_GRACE_MS)

    return () => {
      clearTimeout(timer)
      setGraceActive(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playQueue, currentItem, fetchStatus, resumeTick])

  const roundLabel = useMemo(() => {
    if (fetchStatus === 'closing') return '正在生成结辩高光…'
    const r = Math.floor(feedCountRef.current / chars.length)
    if (r === 0 && feedCountRef.current < chars.length) return '第 0 轮 · 开场'
    return `第 ${r} 轮 · 交锋中`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, chars.length, fetchStatus])

  const speakingId = typing?.char.id ?? null

  // 用户点顶部"我已有答案"：不管现在是哪个阶段，都直接打断、去请求收尾高光。
  // historyRef里已经有的内容（哪怕还没播放完）足够生成靠谱的忠告，
  // 不需要等所有动画播完。
  const handleEnd = () => {
    abortControllerRef.current?.abort()
    fetchClosing()
  }

  // 横幅"再聊聊"：标记这条横幅已处理，请求下一轮
  const handleBannerContinue = (bannerId: number) => {
    setMessages((m) => m.map((msg) => (msg.id === bannerId ? { ...msg, resolved: true } : msg)))
    setFetchStatus('idle')
    fetchRound(nextRoundRef.current)
  }

  // 横幅"去收尾"：标记已处理，直接走收尾流程
  const handleBannerEnd = (bannerId: number) => {
    setMessages((m) => m.map((msg) => (msg.id === bannerId ? { ...msg, resolved: true } : msg)))
    fetchClosing()
  }

  // 请求失败后的手动重试：nextRoundRef只在请求成功时才会+1，
  // 所以失败时它天然还停在"应该重试的那一轮"，直接用它比反推history长度更准确
  // （尤其是插话记录混进history之后，history长度已经不能简单除以人数推算轮次了）
  const handleRetry = () => {
    setConnectionError(null)
    if (fetchStatus === 'error') {
      setFetchStatus('idle')
      fetchRound(nextRoundRef.current)
    }
  }

  const sendInterjection = () => {
    const t = input.trim()
    if (!t) return
    setMessages((m) => [...m, { id: ++idRef.current, kind: 'user', text: t }])
    pendingInterjectionRef.current = t
    setInput('')
    interjectionPausedRef.current = false
    setInterjectionMode(false)
    setResumeTick((n) => n + 1) // 强制watcher effect重新评估，恢复自动推进
  }

  // 点"我要插话"：暂停自动推进，打开输入框。这一刻如果恰好有一轮请求正在飞
  // （fetchStatus==='loading'），那一轮没法收回，会照常返回；但只要用户还没
  // 提交/放弃，watcher就不会再继续往下一轮走，插话不会像以前那样被更远的轮次抢走。
  const openInterjection = () => {
    interjectionPausedRef.current = true
    setInterjectionMode(true)
  }

  // "算了，继续吧"：放弃插话，恢复自动推进，不影响原本的对话内容
  const cancelInterjection = () => {
    interjectionPausedRef.current = false
    setInterjectionMode(false)
    setInput('')
    setResumeTick((n) => n + 1)
  }

  return (
    <div className="screen-in h-full flex flex-col">
      <div className="border-b-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire)] shrink-0">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <span className="font-mono-lc text-xs md:text-sm font-bold border-2 border-[var(--lc-ink)] bg-[var(--lc-ocre)] px-2.5 py-1 shrink-0">
            {roundLabel}
          </span>
          <span className="text-sm text-[var(--lc-ombre)] truncate flex-1 hidden sm:block">
            「{question}」
          </span>
          <button onClick={handleEnd} className="lc-btn lc-btn-vermillon px-3 py-1.5 text-sm shrink-0">
            我已有答案 · 结束辩论
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

      <div className="flex-1 min-h-0 max-w-6xl mx-auto w-full px-4 py-4 flex gap-4">
        <div className="hidden md:flex flex-col gap-3 w-52 shrink-0">
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
                <div className="min-w-0">
                  <div className="font-bold text-sm">{c.name}</div>
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
            ROUND TABLE RADIO
            <br />
            FM 00:00 · 深夜频段
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div ref={feedRef} className="lc-scroll flex-1 min-h-0 overflow-y-auto pr-1 space-y-4 pb-2">
            {messages.map((m) => {
              if (m.kind === 'banner') {
                if (m.resolved) return null
                return (
                  <div
                    key={m.id}
                    className="msg-in border-2 border-[var(--lc-ink)] bg-[var(--lc-ocre)] px-4 py-3 flex items-center gap-3 flex-wrap"
                  >
                    <span className="font-mono-lc text-xs font-bold shrink-0">⚠ 圆桌报警器</span>
                    <span className="text-sm flex-1 min-w-[200px]">{m.text}</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleBannerEnd(m.id)}
                        className="lc-btn lc-btn-outremer px-3 py-1.5 text-sm"
                      >
                        去收尾 →
                      </button>
                      {m.canContinue && (
                        <button
                          onClick={() => handleBannerContinue(m.id)}
                          className="lc-btn lc-btn-ivoire px-3 py-1.5 text-sm"
                        >
                          再聊聊
                        </button>
                      )}
                    </div>
                  </div>
                )
              }

              if (m.kind === 'user') {
                return (
                  <div key={m.id} className="msg-in flex justify-end">
                    <div className="max-w-[85%] border-2 border-[var(--lc-ceruleen)] bg-[var(--lc-ceruleen)]/10 px-4 py-3">
                      <div className="font-mono-lc text-[10px] text-[var(--lc-ceruleen)] font-bold mb-1">
                        你插话了
                      </div>
                      <p className="font-pixel-cn text-xs" style={{ lineHeight: 1.9 }}>{m.text}</p>
                    </div>
                  </div>
                )
              }

              return (
                <div key={m.id} className="msg-in flex gap-3">
                  <div
                    className="w-10 h-10 border-2 shrink-0 overflow-hidden bg-[var(--lc-ivoire-2)]"
                    style={{ borderColor: m.char!.color }}
                  >
                    <img src={m.char!.avatar} alt={m.char!.name} className="pixelated w-full h-full object-cover" />
                  </div>
                  <div className="lc-card-flat max-w-[85%] px-4 py-3">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-bold text-sm" style={{ color: m.char!.color }}>
                        {m.char!.name}
                      </span>
                      {m.tag && (
                        <span className="font-mono-lc text-[10px] border border-[var(--lc-ink)] px-1.5 py-px bg-[var(--lc-ivoire)]">
                          {m.tag}
                        </span>
                      )}
                    </div>
                    <p className="font-pixel-cn text-xs" style={{ lineHeight: 1.9 }}>{m.text}</p>
                  </div>
                </div>
              )
            })}

            {typing && (
              <div className="flex gap-3">
                <div
                  className="w-10 h-10 border-2 shrink-0 overflow-hidden bg-[var(--lc-ivoire-2)]"
                  style={{ borderColor: typing.char.color }}
                >
                  <img src={typing.char.avatar} alt={typing.char.name} className="pixelated w-full h-full object-cover" />
                </div>
                <div className="lc-card-flat max-w-[85%] px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-bold text-sm" style={{ color: typing.char.color }}>
                      {typing.char.name}
                    </span>
                    <span className="font-mono-lc text-[10px] border border-[var(--lc-ink)] px-1.5 py-px bg-[var(--lc-ivoire)]">
                      {typing.tag}
                    </span>
                  </div>
                  <p className="font-pixel-cn text-xs type-cursor" style={{ lineHeight: 1.9 }}>{typing.shown}</p>
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
                <div className="font-mono-lc text-[10px] text-[var(--lc-ceruleen)] font-bold">
                  ⏸ 已暂停，圆桌在等你说完
                </div>
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
              <button
                onClick={openInterjection}
                disabled={fetchStatus === 'closing'}
                className={`lc-btn w-full py-3 text-sm disabled:opacity-40 transition-colors ${
                  graceActive ? 'lc-btn-vermillon' : 'lc-btn-outremer'
                }`}
              >
                {graceActive ? '⏸ 我要插话（现在正好可以）' : '⏸ 我要插话'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
