import { useEffect, useState } from 'react'
import type { Motion } from '../lib/debate'

interface Props {
  question: string
  initial: Motion | null
  onConfirm: (motion: Motion) => void
  onBack: () => void
}

// 立题：把用户的问题变成一道可以站队的辩题。
// 只陈述分歧，不分配立场；用户是主持人，可以直接改字。
export default function MotionScreen({ question, initial, onConfirm, onBack }: Props) {
  const [motion, setMotion] = useState<Motion | null>(initial)
  const [loading, setLoading] = useState(!initial)
  const [error, setError] = useState<string | null>(null)

  const frame = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'frame', question }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.motion) throw new Error(data.error || `立题失败（状态码 ${res.status}）`)
      setMotion(data.motion)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!initial) frame()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const valid = motion && motion.motion.trim() && motion.a.trim() && motion.b.trim()
  const set = (k: keyof Motion) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setMotion((m) => (m ? { ...m, [k]: e.target.value } : m))

  return (
    <div className="screen-in min-h-full flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="flex items-start gap-3 mb-8">
          <button onClick={onBack} className="lc-btn lc-btn-ivoire px-3 py-2 text-sm shrink-0">
            ← 改问题
          </button>
          <div className="lc-card-flat flex-1 px-4 py-3">
            <div className="font-mono-lc text-[10px] tracking-[0.25em] text-[var(--lc-ombre)] mb-1">
              YOUR QUESTION · 你的问题
            </div>
            <div className="font-medium leading-snug">「{question}」</div>
          </div>
        </div>

        <h2 className="font-pixel-cn text-2xl md:text-3xl mb-1">立题</h2>
        <p className="text-sm text-[var(--lc-ombre)] mb-6">
          圆桌要辩出一个结果，先把问题立成二选一。不对就直接改——你是主持人。
        </p>

        <div className="lc-card p-5 md:p-6">
          {loading && (
            <div className="font-mono-lc text-sm text-[var(--lc-ombre)] flex items-center gap-2 py-8 justify-center">
              <span className="pulse-dot">●</span> 正在立题…
            </div>
          )}

          {!loading && error && (
            <div className="py-6 text-center space-y-3">
              <div className="text-sm text-[var(--lc-vermillon)]">{error}</div>
              <button onClick={frame} className="lc-btn lc-btn-outremer px-4 py-2 text-sm">
                重试
              </button>
            </div>
          )}

          {!loading && motion && (
            <div className="space-y-5">
              <label className="block">
                <span className="font-mono-lc text-[10px] tracking-[0.25em] text-[var(--lc-ombre)]">
                  TONIGHT'S MOTION · 辩题
                </span>
                <input
                  value={motion.motion}
                  onChange={set('motion')}
                  maxLength={40}
                  className="mt-1 w-full bg-[var(--lc-ivoire)] border-2 border-[var(--lc-ink)] px-4 py-3 font-pixel-cn text-base outline-none focus:border-[var(--lc-outremer)]"
                />
              </label>
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                <label className="block">
                  <span className="font-mono-lc text-[10px] font-bold text-[var(--lc-outremer)]">立场 A</span>
                  <input
                    value={motion.a}
                    onChange={set('a')}
                    maxLength={12}
                    className="mt-1 w-full bg-[var(--lc-ivoire)] border-2 border-[var(--lc-outremer)] px-3 py-2 text-sm outline-none"
                  />
                </label>
                <span className="font-pixel text-[10px] pb-3">VS</span>
                <label className="block">
                  <span className="font-mono-lc text-[10px] font-bold text-[var(--lc-vert)]">立场 B</span>
                  <input
                    value={motion.b}
                    onChange={set('b')}
                    maxLength={12}
                    className="mt-1 w-full bg-[var(--lc-ivoire)] border-2 border-[var(--lc-vert)] px-3 py-2 text-sm outline-none"
                  />
                </label>
              </div>
              <p className="font-mono-lc text-[10px] text-[var(--lc-ombre)] leading-relaxed">
                嘉宾也可以选「有条件」，但必须说清楚条件是什么。谁站哪边由他们自己决定。
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-center gap-3 mt-8">
          <button onClick={frame} disabled={loading} className="lc-btn lc-btn-ivoire px-5 py-3 text-sm disabled:opacity-40">
            换一种立法 ↻
          </button>
          <button
            onClick={() => valid && onConfirm({ motion: motion!.motion.trim(), a: motion!.a.trim(), b: motion!.b.trim() })}
            disabled={!valid || loading}
            className="lc-btn lc-btn-vermillon px-8 py-3 text-base disabled:opacity-40"
          >
            就辩这个，去选嘉宾 →
          </button>
        </div>
      </div>
    </div>
  )
}
