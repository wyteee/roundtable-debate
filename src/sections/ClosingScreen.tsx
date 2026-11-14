import { useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import type { Character } from '../data/characters'
import { END_REASON_TEXT, STANCE_COLOR, stanceLabel, type DebateResult, type Motion, type Stance } from '../lib/debate'

interface Props {
  motion: Motion
  chars: Character[]
  result: DebateResult
  onRestart: () => void
}

// 裁决卡：结尾回到辩题本身——谁站哪边、凭哪句话、什么能让他改主意。
// 除了每人一句≤40字的忠告（一次轻量压缩），其余全部来自本场发言里的结构化字段。
export default function ClosingScreen({ motion, chars, result, onRestart }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)

  const adviceMap = useMemo(() => new Map(result.advice.map((a) => [a.charId, a.text])), [result.advice])
  const verdictMap = useMemo(() => new Map(result.verdict.map((v) => [v.charId, v])), [result.verdict])
  const getAdvice = (c: Character) => adviceMap.get(c.id) || c.advice

  const tally = useMemo(() => {
    const t: Record<Stance, string[]> = { A: [], B: [], MIXED: [] }
    for (const c of chars) {
      const s = verdictMap.get(c.id)?.stance
      if (s) t[s].push(c.name)
    }
    return t
  }, [chars, verdictMap])

  const headline = (() => {
    const a = tally.A.length
    const b = tally.B.length
    if (a === 3 || b === 3) return `一致：${stanceLabel(motion, a === 3 ? 'A' : 'B')}`
    if (a > b) return `${a} : ${b} 倾向「${motion.a}」`
    if (b > a) return `${b} : ${a} 倾向「${motion.b}」`
    return '势均力敌'
  })()

  const savePng = async () => {
    if (!cardRef.current || saving) return
    setSaving(true)
    try {
      const canvas = await html2canvas(cardRef.current, { backgroundColor: '#f1ead9', scale: 2, useCORS: true })
      const a = document.createElement('a')
      a.download = '圆桌裁决卡.png'
      a.href = canvas.toDataURL('image/png')
      a.click()
    } finally {
      setSaving(false)
    }
  }

  const Chip = ({ s }: { s: Stance | null | undefined }) =>
    s ? (
      <span
        className="font-mono-lc text-[10px] px-1.5 py-px font-bold text-[var(--lc-ivoire)] whitespace-nowrap"
        style={{ background: STANCE_COLOR[s] }}
      >
        {stanceLabel(motion, s)}
      </span>
    ) : null

  return (
    <div className="screen-in min-h-full px-4 py-10 max-w-6xl mx-auto">
      <div className="font-mono-lc text-xs tracking-[0.3em] text-center text-[var(--lc-ombre)] mb-3">
        TONIGHT'S VERDICT · 今夜裁决 · {END_REASON_TEXT[result.endReason]}
      </div>
      <h2 className="font-pixel-cn text-2xl md:text-3xl text-center mb-2">「{motion.motion}」</h2>
      <p className="font-pixel-cn text-lg text-center text-[var(--lc-vermillon)] mb-6">{headline}</p>

      {/* 计票条 */}
      <div className="max-w-xl mx-auto flex border-2 border-[var(--lc-ink)] mb-10 font-mono-lc text-[11px] font-bold text-[var(--lc-ivoire)]">
        {(['A', 'MIXED', 'B'] as Stance[]).map((s) =>
          tally[s].length ? (
            <div key={s} className="px-2 py-1.5 text-center truncate" style={{ background: STANCE_COLOR[s], flex: tally[s].length }}>
              {stanceLabel(motion, s)} · {tally[s].join('、')}
            </div>
          ) : null,
        )}
      </div>

      <div className="flex flex-col lg:flex-row gap-8 items-start justify-center">
        <div className="flex-1 w-full space-y-5 max-w-xl">
          {chars.map((c) => {
            const v = verdictMap.get(c.id)
            const moved = v && v.path.length > 1
            return (
              <div key={c.id} className="lc-card p-5 flex gap-4">
                <div className="w-16 h-16 border-2 shrink-0 overflow-hidden bg-[var(--lc-ivoire)]" style={{ borderColor: c.color }}>
                  <img src={c.avatar} alt={c.name} className="pixelated w-full h-full object-cover" />
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold" style={{ color: c.color }}>
                      {c.name}
                    </span>
                    <Chip s={v?.stance} />
                    {v?.confidence ? (
                      <span className="font-mono-lc text-[10px] text-[var(--lc-ombre)]">
                        信心 {'●'.repeat(v.confidence)}
                        {'○'.repeat(5 - v.confidence)}
                      </span>
                    ) : null}
                    {moved && (
                      <span className="font-mono-lc text-[10px] text-[var(--lc-ombre)]">
                        途中改过立场：{v!.path.map((s) => stanceLabel(motion, s)).join(' → ')}
                      </span>
                    )}
                  </div>
                  <p className="font-pixel-cn text-sm" style={{ lineHeight: 1.9 }}>
                    「{getAdvice(c)}」
                  </p>
                  {v?.quote && (
                    <p className="text-xs text-[var(--lc-ombre)] leading-relaxed border-l-2 border-[var(--lc-ink)] pl-2">
                      出处 · 本场原话：{v.quote}
                    </p>
                  )}
                  {v?.changeMind && (
                    <p className="text-xs leading-relaxed">
                      <span className="font-mono-lc text-[10px] font-bold">什么能让他改主意：</span>
                      {v.changeMind}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
          <p className="font-mono-lc text-[11px] text-[var(--lc-ombre)] leading-relaxed">
            圆桌不替你做决定。看看上面三条「什么能让他改主意」——哪一条在你身上成立，答案大概就在那边。
          </p>
        </div>

        {/* 分享卡预览 */}
        <div className="shrink-0 flex flex-col items-center gap-5 w-full lg:w-auto">
          <div
            ref={cardRef}
            className="w-[320px] border-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire)] p-6"
            style={{
              boxShadow: '6px 6px 0 var(--lc-ink)',
              backgroundImage:
                'linear-gradient(rgba(34,31,26,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(34,31,26,0.05) 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          >
            <div className="font-mono-lc text-[9px] tracking-[0.3em] text-[var(--lc-ombre)] mb-4">LATE-NIGHT RADIO · 圆桌</div>
            <div className="font-pixel-cn text-lg leading-snug mb-1">「{motion.motion}」</div>
            <div className="font-pixel text-[7px] text-[var(--lc-vermillon)] mb-4">TONIGHT'S VERDICT</div>
            <div className="font-pixel-cn text-base mb-4">{headline}</div>

            <div className="space-y-3 mb-5">
              {chars.map((c) => (
                <div key={c.id} className="flex gap-2 items-start text-sm leading-snug">
                  <div className="w-8 h-8 border-2 border-[var(--lc-ink)] overflow-hidden shrink-0" style={{ boxShadow: `2px 2px 0 ${c.color}` }}>
                    <img src={c.avatar} alt={c.name} className="pixelated w-full h-full object-cover" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-xs" style={{ color: c.color }}>
                        {c.name}
                      </span>
                      <Chip s={verdictMap.get(c.id)?.stance} />
                    </div>
                    <div className="font-pixel-cn text-xs line-clamp-2">{getAdvice(c)}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t-2 border-[var(--lc-ink)] pt-3 font-mono-lc text-[10px] text-[var(--lc-ombre)] leading-relaxed">
              今晚请 {chars.map((c) => c.name).join('、')} 辩论了我的问题
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={savePng} disabled={saving} className="lc-btn lc-btn-ocre px-5 py-3 text-sm">
              {saving ? '生成中…' : '保存图片 ↓'}
            </button>
            <button onClick={onRestart} className="lc-btn lc-btn-vermillon px-5 py-3 text-sm">
              再开一场新的圆桌 ↻
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
