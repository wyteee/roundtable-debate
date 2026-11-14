import { useState } from 'react'
import './App.css'
import { CHARACTERS, type Character } from './data/characters'
import LandingScreen from './sections/LandingScreen'
import CastingScreen from './sections/CastingScreen'
import DebateScreen from './sections/DebateScreen'
import MotionScreen from './sections/MotionScreen'
import type { DebateResult, Motion } from './lib/debate'
import { useI18n, type Lang } from './lib/i18n'
import ClosingScreen from './sections/ClosingScreen'

type Screen = 'landing' | 'motion' | 'casting' | 'debate' | 'closing'

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [question, setQuestion] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const { lang } = useI18n()
  const [motion, setMotion] = useState<Motion | null>(null)
  // 立好的辩题属于某一种语言；回到首页换了语言再提交，就要重新立题
  const [motionLang, setMotionLang] = useState<Lang>(lang)
  // 本场辩论真实结束后拿到的数据：裁决（最终立场/出处/改主意条件）+ 每人一句忠告
  const [debateResult, setDebateResult] = useState<DebateResult>({ advice: [], verdict: [], endReason: 'user' })

  const toggle = (id: string) => {
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length < 3 ? [...s, id] : s,
    )
  }

  const selectedChars: Character[] = selected
    .map((id) => CHARACTERS.find((c) => c.id === id))
    .filter(Boolean) as Character[]

  const restart = () => {
    setQuestion('')
    setSelected([])
    setMotion(null)
    setDebateResult({ advice: [], verdict: [], endReason: 'user' })
    setScreen('landing')
  }

  return (
    <div className="h-full">
      {screen === 'landing' && (
        <LandingScreen
          initial={question}
          onSubmit={(q) => {
            if (q !== question || lang !== motionLang) setMotion(null)
            setQuestion(q)
            setScreen('motion')
          }}
        />
      )}
      {screen === 'motion' && (
        <MotionScreen
          question={question}
          initial={motion}
          onConfirm={(m) => {
            setMotion(m)
            setMotionLang(lang)
            setScreen('casting')
          }}
          onBack={() => setScreen('landing')}
        />
      )}
      {screen === 'casting' && motion && (
        <CastingScreen
          question={motion.motion}
          selected={selected}
          onToggle={toggle}
          onStart={() => setScreen('debate')}
          onBack={() => setScreen('motion')}
        />
      )}
      {screen === 'debate' && motion && (
        <DebateScreen
          question={question}
          motion={motion}
          chars={selectedChars}
          onEnd={(result) => {
            setDebateResult(result)
            setScreen('closing')
          }}
        />
      )}
      {screen === 'closing' && motion && (
        <ClosingScreen
          motion={motion}
          chars={selectedChars}
          result={debateResult}
          onRestart={restart}
        />
      )}
    </div>
  )
}
