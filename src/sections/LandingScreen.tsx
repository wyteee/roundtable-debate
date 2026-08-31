import { useState } from 'react'
import { CHARACTERS } from '../data/characters'

interface Props {
  onSubmit: (question: string) => void
}

const MAX_LEN = 200

export default function LandingScreen({ onSubmit }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  const len = text.length
  const over = len > MAX_LEN

  const submit = () => {
    if (over) return
    if (text.trim().length < 5) {
      setError('再写多一点吧——至少 5 个字，圆桌才知道该辩什么。')
      return
    }
    onSubmit(text.trim())
  }

  return (
    <div className="screen-in min-h-full flex flex-col items-center justify-center px-4 py-12">
      {/* kicker */}
      <div className="font-mono-lc text-xs md:text-sm tracking-[0.3em] mb-6 flex items-center gap-3">
        <span className="inline-block w-8 h-[2px] bg-[var(--lc-ink)]" />
        LATE-NIGHT RADIO · 深夜辩论电台
        <span className="inline-block w-8 h-[2px] bg-[var(--lc-ink)]" />
      </div>

      {/* 标题 */}
      <h1 className="font-pixel-cn tracking-tight leading-none mb-3" style={{ fontSize: 'clamp(60px, 10vw, 96px)' }}>
        圆桌
      </h1>
      <div className="font-pixel text-[10px] md:text-xs text-[var(--lc-vermillon)] tracking-widest mb-8">
        R O U N D T A B L E
      </div>

      <p className="text-center text-base md:text-lg max-w-xl leading-relaxed mb-10">
        你写下一个人生问题，三位历史名人的「电子灵魂」
        <br className="hidden md:block" />
        围坐在圆桌前，为你辩论一场。
      </p>

      {/* 输入区 */}
      <div className="lc-card w-full max-w-2xl p-5 md:p-6">
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError('')
          }}
          rows={4}
          placeholder={'写下你的问题……\n比如：「韬光养晦更好，还是锋芒毕露更好」「人活着的意义是什么」'}
          className="w-full bg-[var(--lc-ivoire)] border-2 border-[var(--lc-ink)] p-4 text-base leading-relaxed resize-none outline-none focus:border-[var(--lc-outremer)] focus:shadow-[3px_3px_0_var(--lc-outremer)] transition-shadow placeholder:text-[var(--lc-ombre)]"
        />
        <div className="flex items-center justify-between mt-3">
          <div className="font-mono-lc text-xs text-[var(--lc-ombre)]">
            {error ? (
              <span className="text-[var(--lc-vermillon)] font-bold">{error}</span>
            ) : (
              '问题不会被保存，圆桌只属于今夜'
            )}
          </div>
          <div
            className={`font-mono-lc text-xs ${
              over ? 'text-[var(--lc-vermillon)] font-bold' : 'text-[var(--lc-ombre)]'
            }`}
          >
            {len}/{MAX_LEN}
          </div>
        </div>
      </div>

      <button
        onClick={submit}
        disabled={over}
        className="lc-btn lc-btn-vermillon mt-8 px-10 py-4 text-lg"
      >
        召集圆桌 →
      </button>

      {/* 今晚的嘉宾 */}
      <div className="mt-14 flex flex-col items-center gap-3">
        <div className="font-mono-lc text-xs tracking-[0.25em] text-[var(--lc-ombre)]">
          TONIGHT'S GUESTS · 今晚待命的 8 位嘉宾
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {CHARACTERS.map((c) => (
            <div
              key={c.id}
              title={c.name}
              className="w-12 h-12 border-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire-2)] overflow-hidden"
              style={{ boxShadow: `3px 3px 0 ${c.color}` }}
            >
              <img
                src={c.avatar}
                alt={c.name}
                className="pixelated w-full h-full object-cover"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
