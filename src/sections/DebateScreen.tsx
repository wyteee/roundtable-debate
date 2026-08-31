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
}

// 对应后端 api/debate.js 推送的SSE事件格式
type ServerEvent =
  | { type: 'speech'; charId: string; text: string; tag: string }
  | { type: 'banner'; text: string }
  | { type: 'advice'; charId: string; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

interface PlayItem {
  char: Character
  text: string
  tag: string
}

// ---- 打字/阅读节奏相关的可调常量 ----
// 之前是固定 26ms/字 + 650ms停顿，太快了，一条还没读完下一条就上来了。
// 现在：逐字速度放慢，且每条播完后的停留时间跟这条话的长度挂钩（长发言多留时间），
// 而不是无论长短都停一样久。
const TYPE_MS_PER_CHAR = 45 // 每个字之间的间隔（原来26ms）
const READ_PAUSE_BASE_MS = 1400 // 播完一条后，最少留多久给用户读（原来固定650ms）
const READ_PAUSE_PER_CHAR_MS = 35 // 在base基础上，按字数再叠加的阅读时间
const READ_PAUSE_MAX_MS = 3600 // 单条发言最多留多久，避免太长的话卡太久
// 收到done事件后，如果播放已经追上了，再等这么久才真正触发收尾，
// 避免最后一条发言刚出现用户还没读完就被跳走
const AUTO_END_DELAY_AFTER_CAUGHT_UP_MS = 1800

export default function DebateScreen({ question, chars, onEnd }: Props) {
  const [messages, setMessages] = useState<Msg[]>([])
  // 播放队列现在是正经的React状态（不是ref），这样新内容到达时会自动触发下面
  // 那个effect重新检查，不再依赖手写while循环去"轮询"一个ref，那套机制不稳定。
  const [playQueue, setPlayQueue] = useState<PlayItem[]>([])
  const [typing, setTyping] = useState<(PlayItem & { shown: string }) | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  // 后端SSE流是否已经推完（不代表播放动画已经放完，两者是分开的）
  const [streamDone, setStreamDone] = useState(false)

  const idRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  // 本场真实的收尾高光，从后端advice事件里攒出来的，最终要整个传给收尾屏
  const adviceRef = useRef<{ charId: string; text: string }[]>([])
  const feedRef = useRef<HTMLDivElement>(null)
  const feedCountRef = useRef(0)
  const charById = useMemo(() => new Map(chars.map((c) => [c.id, c])), [chars])
  // 当前正在播放的这一条，从playQueue里取出来后单独放这里
  const [currentItem, setCurrentItem] = useState<PlayItem | null>(null)
  // 防止自动收尾的useEffect因为依赖变化重复触发多次handleEnd
  const autoEndTriggeredRef = useRef(false)

  // ---- 出队effect：只负责"队列有内容 && 当前没在播"时，把队首挪到currentItem ----
  // 依赖是[playQueue, currentItem]，但这个effect内部不会去改playQueue和currentItem
  // 之外的东西，不会出现"自己写的状态把自己刚触发的动画立刻打断"的问题
  useEffect(() => {
    if (currentItem) return
    if (playQueue.length === 0) return
    const [item, ...rest] = playQueue
    setCurrentItem(item)
    setPlayQueue(rest)
  }, [playQueue, currentItem])

  // ---- 打字动画effect：只依赖currentItem，currentItem整个播放周期内只变化两次
  // （null→有内容→null），播放过程中不会因为playQueue变化被意外打断 ----
  useEffect(() => {
    if (!currentItem) return
    let i = 0
    const timer = setInterval(() => {
      i++
      setTyping({ ...currentItem, shown: currentItem.text.slice(0, i) })
      if (i >= currentItem.text.length) {
        clearInterval(timer)
        // 根据这条发言的长度动态决定读完后停留多久，而不是固定650ms，
        // 短句少等一点，长句多留时间读完
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
          setCurrentItem(null) // 播完了，触发上面那个出队effect去拿下一条
        }, pause)
      }
    }, TYPE_MS_PER_CHAR)

    return () => clearInterval(timer)
  }, [currentItem])

  useEffect(() => {
    const controller = new AbortController()
    abortControllerRef.current = controller

    const run = async () => {
      try {
        const res = await fetch('/api/debate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, characterIds: chars.map((c) => c.id) }),
          signal: controller.signal,
        })

        if (!res.ok || !res.body) {
          setConnectionError(`接口请求失败（状态码 ${res.status}）`)
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''

          for (const frame of frames) {
            const line = frame.trim()
            if (!line.startsWith('data:')) continue
            const jsonStr = line.slice(5).trim()
            if (!jsonStr) continue

            let event: ServerEvent
            try {
              event = JSON.parse(jsonStr)
            } catch {
              continue
            }

            if (event.type === 'speech') {
              const char = charById.get(event.charId)
              if (char) {
                setPlayQueue((q) => [...q, { char, text: event.text, tag: event.tag }])
              }
            } else if (event.type === 'banner') {
              setMessages((m) => [
                ...m,
                { id: ++idRef.current, kind: 'banner', text: event.text },
              ])
            } else if (event.type === 'advice') {
              // 真实的收尾高光，先攒着，等辩论真正结束（自动或手动）时一起传给收尾屏
              adviceRef.current.push({ charId: event.charId, text: event.text })
            } else if (event.type === 'done') {
              // 后端流已经推完所有内容（包括收尾高光）。这里只标记"流结束"，
              // 不在这里直接跳转——playQueue里可能还有没播完的发言，
              // 真正的自动跳转由下面那个effect在"播放也追上了"之后触发。
              setStreamDone(true)
            } else if (event.type === 'error') {
              setConnectionError(event.message)
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setConnectionError('连接中断，请稍后重试')
        }
      }
    }

    run()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, typing])

  // ---- 自动收尾effect：streamDone为true，且播放队列清空、当前也没在播的时候，
  // 说明后端内容已经全部推完，且用户也已经把最后一条看完了，再等一小段缓冲时间
  // 后自动结束辩论、跳转收尾屏。----
  useEffect(() => {
    if (!streamDone) return
    if (playQueue.length > 0) return
    if (currentItem) return
    if (autoEndTriggeredRef.current) return

    const timer = setTimeout(() => {
      if (autoEndTriggeredRef.current) return
      autoEndTriggeredRef.current = true
      abortControllerRef.current?.abort()
      onEnd({ advice: adviceRef.current })
    }, AUTO_END_DELAY_AFTER_CAUGHT_UP_MS)

    return () => clearTimeout(timer)
  }, [streamDone, playQueue, currentItem, onEnd])

  const roundLabel = useMemo(() => {
    const r = Math.floor(feedCountRef.current / chars.length)
    if (r === 0 && feedCountRef.current < chars.length) return '第 0 轮 · 开场'
    return `第 ${Math.min(r, 4)} / 4 轮 · 交锋中`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, chars.length])

  const speakingId = typing?.char.id ?? null

  // 用户手动点"我已有答案"结束：此时后端advice事件不一定已经推送完（比如用户在
  // 交锋轮中途就想结束），adviceRef.current里有多少算多少，收尾屏那边会对
  // 没拿到真实advice的角色做兜底处理
  const handleEnd = () => {
    autoEndTriggeredRef.current = true // 别再让自动收尾effect重复触发
    abortControllerRef.current?.abort()
    onEnd({ advice: adviceRef.current })
  }

  const sendInterjection = () => {
    const t = input.trim()
    if (!t) return
    setMessages((m) => [...m, { id: ++idRef.current, kind: 'user', text: t }])
    setInput('')
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
          <div className="border-2 border-[var(--lc-vermillon)] bg-[var(--lc-vermillon)]/10 px-4 py-2 text-sm">
            {connectionError}
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
                if (bannerDismissed) return null
                return (
                  <div
                    key={m.id}
                    className="msg-in border-2 border-[var(--lc-ink)] bg-[var(--lc-ocre)] px-4 py-3 flex items-center gap-3 flex-wrap"
                  >
                    <span className="font-mono-lc text-xs font-bold shrink-0">⚠ 圆桌报警器</span>
                    <span className="text-sm flex-1 min-w-[200px]">{m.text}</span>
                    <div className="flex gap-2">
                      <button onClick={handleEnd} className="lc-btn lc-btn-outremer px-3 py-1.5 text-sm">
                        去收尾 →
                      </button>
                      <button
                        onClick={() => setBannerDismissed(true)}
                        className="lc-btn lc-btn-ivoire px-3 py-1.5 text-sm"
                      >
                        再聊聊
                      </button>
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
          </div>

          <div className="shrink-0 flex gap-2 pb-1">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendInterjection()}
              placeholder="随时插话、追问，或直接说「我已有答案」……"
              className="flex-1 min-w-0 bg-[var(--lc-ivoire-2)] border-2 border-[var(--lc-ink)] px-4 py-3 text-sm outline-none focus:border-[var(--lc-outremer)] placeholder:text-[var(--lc-ombre)]"
            />
            <button onClick={sendInterjection} className="lc-btn lc-btn-outremer px-5 py-3 text-sm shrink-0">
              插话
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
