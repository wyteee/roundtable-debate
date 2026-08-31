import { useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import type { Character } from '../data/characters'

interface Props {
  question: string
  chars: Character[]
  // 本场真实生成的收尾高光（来自 /api/debate 的 advice 事件）
  advice: { charId: string; text: string }[]
  onRestart: () => void
}

export default function ClosingScreen({ question, chars, advice, onRestart }: Props) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)

  // 用charId查真实advice；如果这个角色因为提前结束/出错没拿到真实advice，
  // 兜底退回characters.ts里的静态文案，保证界面不会空着，但优先永远是真实数据
  const adviceMap = useMemo(() => new Map(advice.map((a) => [a.charId, a.text])), [advice])
  const getAdvice = (c: Character) => adviceMap.get(c.id) ?? c.advice

  const savePng = async () => {
    if (!cardRef.current || saving) return
    setSaving(true)
    try {
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: '#f1ead9',
        scale: 2,
        useCORS: true,
      })
      const a = document.createElement('a')
      a.download = '圆桌分享卡.png'
      a.href = canvas.toDataURL('image/png')
      a.click()
    } finally {
      setSaving(false)
    }
  }

  const shortQuestion = question.length > 18 ? question.slice(0, 18) + '…' : question

  return (
    <div className="screen-in min-h-full px-4 py-10 max-w-6xl mx-auto">
      <div className="font-mono-lc text-xs tracking-[0.3em] text-center text-[var(--lc-ombre)] mb-3">
        FINAL ADVICE · 结辩高光
      </div>
      <h2 className="font-pixel-cn text-3xl md:text-4xl text-center mb-2">三句忠告</h2>
      <p className="font-pixel text-[9px] text-center text-[var(--lc-vermillon)] mb-10">
        THREE PIECES OF ADVICE
      </p>

      <div className="flex flex-col lg:flex-row gap-8 items-start justify-center">
        {/* 三张高光卡 */}
        <div className="flex-1 w-full space-y-5 max-w-xl">
          {chars.map((c) => (
            <div key={c.id} className="lc-card p-5 flex gap-4">
              <div
                className="w-16 h-16 border-2 shrink-0 overflow-hidden bg-[var(--lc-ivoire)]"
                style={{ borderColor: c.color }}
              >
                <img src={c.avatar} alt={c.name} className="pixelated w-full h-full object-cover" />
              </div>
              <div>
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="font-bold" style={{ color: c.color }}>
                    {c.name}的忠告
                  </span>
                  <span className="font-mono-lc text-[10px] text-[var(--lc-ombre)]">
                    摘自本场发言
                  </span>
                </div>
                <p className="font-pixel-cn text-sm" style={{ lineHeight: 1.9 }}>「{getAdvice(c)}」</p>
              </div>
            </div>
          ))}
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
            <div className="font-mono-lc text-[9px] tracking-[0.3em] text-[var(--lc-ombre)] mb-4">
              LATE-NIGHT RADIO · 圆桌
            </div>
            <div className="font-pixel-cn text-xl leading-snug mb-1">「{shortQuestion}」</div>
            <div className="font-pixel text-[7px] text-[var(--lc-vermillon)] mb-5">
              TONIGHT'S DEBATE
            </div>

            {/* 叠层头像 */}
            <div className="flex mb-5">
              {chars.map((c, i) => (
                <div
                  key={c.id}
                  className="w-14 h-14 border-2 border-[var(--lc-ink)] overflow-hidden bg-[var(--lc-ivoire-2)]"
                  style={{ marginLeft: i === 0 ? 0 : -10, boxShadow: `3px 3px 0 ${c.color}`, zIndex: 3 - i }}
                >
                  <img src={c.avatar} alt={c.name} className="pixelated w-full h-full object-cover" />
                </div>
              ))}
            </div>

            <div className="space-y-3 mb-5">
              {chars.map((c) => (
                <div key={c.id} className="flex gap-2 text-sm leading-snug">
                  <span className="shrink-0 font-bold" style={{ color: c.color }}>
                    {c.name}：
                  </span>
                  <span className="font-pixel-cn text-xs line-clamp-1">{getAdvice(c)}</span>
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
