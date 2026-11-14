import { useEffect, useState } from 'react'
import type { Motion } from '../lib/debate'
import { useI18n } from '../lib/i18n'

interface Props {
  question: string
  initial: Motion | null
  onConfirm: (motion: Motion) => void
  onBack: () => void
}

// 立题：把用户的问题变成一道可以站队的辩题。
// 只陈述分歧，不分配立场；用户是主持人，可以直接改字。
export default function MotionScreen({ question, initial, onConfirm, onBack }: Props) {
  const { t, lang, q } = useI18n()
  const [motion, setMotion] = useState<Motion | null>(initial)
  const [loading, setLoading] = useState(!initial)
  const [error, setError] = useState<string | null>(null)
  const [needsEdit, setNeedsEdit] = useState(false)

  const frame = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'frame', question, lang }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.motion) throw new Error(data.error || t('motion.failed', { status: res.status }))
      const { needsEdit: ne, ...m } = data.motion
      setMotion(m)
      setNeedsEdit(!!ne)
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
            {t('motion.back')}
          </button>
          <div className="lc-card-flat flex-1 px-4 py-3">
            <div className="font-mono-lc text-[10px] tracking-[0.25em] text-[var(--lc-ombre)] mb-1">
              {t('motion.yourQuestion')}
            </div>
            <div className="font-medium leading-snug">{q(question)}</div>
          </div>
        </div>

        <h2 className="font-pixel-cn text-2xl md:text-3xl mb-1">{t('motion.title')}</h2>
        <p className="text-sm text-[var(--lc-ombre)] mb-6">
          {t('motion.desc')}
        </p>

        <div className="lc-card p-5 md:p-6">
          {loading && (
            <div className="font-mono-lc text-sm text-[var(--lc-ombre)] flex items-center gap-2 py-8 justify-center">
              <span className="pulse-dot">●</span> {t('motion.loading')}
            </div>
          )}

          {!loading && error && (
            <div className="py-6 text-center space-y-3">
              <div className="text-sm text-[var(--lc-vermillon)]">{error}</div>
              <button onClick={frame} className="lc-btn lc-btn-outremer px-4 py-2 text-sm">
                {t('motion.retry')}
              </button>
            </div>
          )}

          {!loading && motion && (
            <div className="space-y-5">
              {needsEdit && (
                <div className="border-2 border-[var(--lc-ocre)] bg-[var(--lc-ocre)]/15 px-3 py-2 text-sm">
                  {t('motion.needsEdit')}
                </div>
              )}
              <label className="block">
                <span className="font-mono-lc text-[10px] tracking-[0.25em] text-[var(--lc-ombre)]">
                  {t('motion.label')}
                </span>
                <input
                  value={motion.motion}
                  onChange={set('motion')}
                  maxLength={lang === 'en' ? 90 : 40}
                  className="mt-1 w-full bg-[var(--lc-ivoire)] border-2 border-[var(--lc-ink)] px-4 py-3 font-pixel-cn text-base outline-none focus:border-[var(--lc-outremer)]"
                />
              </label>
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
                <label className="block">
                  <span className="font-mono-lc text-[10px] font-bold text-[var(--lc-outremer)]">{t('motion.sideA')}</span>
                  <input
                    value={motion.a}
                    onChange={set('a')}
                    maxLength={lang === 'en' ? 32 : 12}
                    className="mt-1 w-full bg-[var(--lc-ivoire)] border-2 border-[var(--lc-outremer)] px-3 py-2 text-sm outline-none"
                  />
                </label>
                <span className="font-pixel text-[10px] pb-3">VS</span>
                <label className="block">
                  <span className="font-mono-lc text-[10px] font-bold text-[var(--lc-vert)]">{t('motion.sideB')}</span>
                  <input
                    value={motion.b}
                    onChange={set('b')}
                    maxLength={lang === 'en' ? 32 : 12}
                    className="mt-1 w-full bg-[var(--lc-ivoire)] border-2 border-[var(--lc-vert)] px-3 py-2 text-sm outline-none"
                  />
                </label>
              </div>
              <p className="font-mono-lc text-[10px] text-[var(--lc-ombre)] leading-relaxed">
                {t('motion.hint')}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-center gap-3 mt-8">
          <button onClick={frame} disabled={loading} className="lc-btn lc-btn-ivoire px-5 py-3 text-sm disabled:opacity-40">
            {t('motion.reframe')}
          </button>
          <button
            onClick={() => valid && onConfirm({ motion: motion!.motion.trim(), a: motion!.a.trim(), b: motion!.b.trim() })}
            disabled={!valid || loading}
            className="lc-btn lc-btn-vermillon px-8 py-3 text-base disabled:opacity-40"
          >
            {t('motion.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
