import { CHARACTERS, charText, type Character } from '../data/characters'
import { useI18n } from '../lib/i18n'

interface Props {
  question: string
  selected: string[]
  onToggle: (id: string) => void
  onStart: () => void
  onBack: () => void
}

const FULL = 3

export default function CastingScreen({
  question,
  selected,
  onToggle,
  onStart,
  onBack,
}: Props) {
  const { t, lang, q } = useI18n()
  const full = selected.length >= FULL
  const selectedChars = selected
    .map((id) => CHARACTERS.find((c) => c.id === id))
    .filter(Boolean) as Character[]

  return (
    <div className="screen-in min-h-full flex flex-col px-4 py-8 max-w-6xl mx-auto w-full">
      {/* 顶部：回显问题 */}
      <div className="flex items-start gap-3 mb-8">
        <button onClick={onBack} className="lc-btn lc-btn-ivoire px-3 py-2 text-sm shrink-0">
          {t('casting.back')}
        </button>
        <div className="lc-card-flat flex-1 px-4 py-3">
          <div className="font-mono-lc text-[10px] tracking-[0.25em] text-[var(--lc-ombre)] mb-1">
            {t('casting.motionLabel')}
          </div>
          <div className="font-medium leading-snug">{q(question)}</div>
        </div>
      </div>

      <h2 className="font-pixel-cn text-2xl md:text-3xl mb-1">
        {t('casting.title')}
      </h2>
      <p className="text-sm text-[var(--lc-ombre)] mb-6">
        {t('casting.desc')}
      </p>

      {/* 嘉宾网格 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-5 mb-28">
        {CHARACTERS.map((c) => {
          const isSelected = selected.includes(c.id)
          const locked = full && !isSelected
          return (
            <button
              key={c.id}
              onClick={() => onToggle(c.id)}
              className={`guest-card text-left border-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire-2)] p-4 relative ${
                locked ? 'locked opacity-40' : ''
              } ${isSelected ? 'selected' : ''}`}
              style={{
                boxShadow: isSelected
                  ? `5px 5px 0 ${c.color}`
                  : '3px 3px 0 var(--lc-ink)',
              }}
            >
              {isSelected && (
                <span
                  className="absolute -top-2.5 -right-2 font-mono-lc text-[10px] px-2 py-0.5 border-2 border-[var(--lc-ink)] text-[var(--lc-ivoire)]"
                  style={{ background: c.color }}
                >
                  {t('casting.seated')}
                </span>
              )}
              <div
                className="w-20 h-20 md:w-24 md:h-24 mx-auto mb-3 border-2 border-[var(--lc-ink)] overflow-hidden bg-[var(--lc-ivoire)]"
                style={{ outline: `3px solid ${isSelected ? c.color : 'transparent'}` }}
              >
                <img
                  src={c.avatar}
                  alt={charText(c, lang).name}
                  className="pixelated w-full h-full object-cover"
                />
              </div>
              <div className="text-center">
                <div className="font-bold text-lg leading-tight">{charText(c, lang).name}</div>
                {lang === 'zh' && (
                  <div className="font-pixel text-[7px] mt-1" style={{ color: c.color }}>
                    {c.latin}
                  </div>
                )}
              </div>
              <p className="font-pixel-cn text-xs mt-3 text-[var(--lc-ink)]/80 min-h-[3rem]" style={{ lineHeight: 1.8 }}>
                {charText(c, lang).quote}
              </p>
            </button>
          )
        })}
      </div>

      {/* 底部常驻状态栏 */}
      <div className="fixed bottom-0 left-0 right-0 border-t-2 border-[var(--lc-ink)] bg-[var(--lc-ivoire)] z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="font-mono-lc text-xs md:text-sm min-w-0">
            <span className="font-bold">{t('casting.count', { n: selected.length, max: FULL })}</span>
            {selectedChars.length > 0 && (
              <span className="text-[var(--lc-ombre)] truncate">
                {t('casting.sep') + selectedChars.map((c) => charText(c, lang).name).join(' · ')}
              </span>
            )}
          </div>
          <button
            onClick={onStart}
            disabled={!full}
            title={full ? '' : t('casting.needThree')}
            className="lc-btn lc-btn-outremer px-6 py-3 shrink-0"
          >
            {t('casting.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
