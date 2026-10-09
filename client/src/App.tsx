import { useState } from 'react'
import { type Deck, type Session } from './api'
import { Picker } from './components/Picker'
import { Presenter } from './components/Presenter'

export default function App() {
  const [active, setActive] = useState<{ deck: Deck; session: Session } | null>(null)

  if (active) {
    return (
      <Presenter
        deck={active.deck}
        session={active.session}
        onEnd={() => setActive(null)}
      />
    )
  }

  return <Picker onStart={(deck, session) => setActive({ deck, session })} />
}
