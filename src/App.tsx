import { useState } from 'react'
import './App.css'
import { CHARACTERS, type Character } from './data/characters'
import LandingScreen from './sections/LandingScreen'
import CastingScreen from './sections/CastingScreen'
import DebateScreen, { type DebateResult } from './sections/DebateScreen'
import ClosingScreen from './sections/ClosingScreen'

type Screen = 'landing' | 'casting' | 'debate' | 'closing'

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing')
  const [question, setQuestion] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  // 本场辩论真实结束后拿到的数据（目前是每个角色的收尾高光忠告）
  const [debateResult, setDebateResult] = useState<DebateResult>({ advice: [] })

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
    setDebateResult({ advice: [] })
    setScreen('landing')
  }

  return (
    <div className="h-full">
      {screen === 'landing' && (
        <LandingScreen
          onSubmit={(q) => {
            setQuestion(q)
            setScreen('casting')
          }}
        />
      )}
      {screen === 'casting' && (
        <CastingScreen
          question={question}
          selected={selected}
          onToggle={toggle}
          onStart={() => setScreen('debate')}
          onBack={() => setScreen('landing')}
        />
      )}
      {screen === 'debate' && (
        <DebateScreen
          question={question}
          chars={selectedChars}
          onEnd={(result) => {
            setDebateResult(result)
            setScreen('closing')
          }}
        />
      )}
      {screen === 'closing' && (
        <ClosingScreen
          question={question}
          chars={selectedChars}
          advice={debateResult.advice}
          onRestart={restart}
        />
      )}
    </div>
  )
}
