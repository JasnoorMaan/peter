import { useEffect, useState } from 'react'
import { createSession, getDeck, listDecks, uploadDeck, type Deck, type DeckListItem, type Session } from '../api'

export function Picker({ onStart }: { onStart: (deck: Deck, session: Session) => void }) {
  const [decks, setDecks] = useState<DeckListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)

  useEffect(() => {
    let gone = false
    listDecks()
      .then((next) => {
        if (!gone) setDecks(next)
      })
      .catch((cause: unknown) => {
        if (!gone) setError(cause instanceof Error ? cause.message : 'Could not load decks')
      })
    return () => {
      gone = true
    }
  }, [])

  async function upload(file: File) {
    const name = file.name.toLowerCase()
    if (!name.endsWith('.pptx') && !name.endsWith('.pdf')) {
      setError('Upload a .pptx or .pdf file.')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('The file is larger than 20 MB.')
      return
    }
    setPreparing(true)
    setError(null)
    try {
      const deck = await uploadDeck(file)
      const session = await createSession(deck.id)
      onStart(deck, session)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare that deck')
      setPreparing(false)
    }
  }

  async function open(id: string) {
    setOpening(id)
    setError(null)
    try {
      const [deck, session] = await Promise.all([getDeck(id), createSession(id)])
      onStart(deck, session)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not open that deck')
      setOpening(null)
    }
  }

  return (
    <main className="landing">
      <header className="landing-bar">
        <p className="product">peter.</p>
      </header>
      <section className="intro">
        <h1>Hi, I'm Peter</h1>
        <p className="lede">Pick a deck and I'll present it. Interrupt me any time.</p>
      </section>
      <section className="deck-section" aria-label="Decks">
        <h2>Choose a deck</h2>
        {decks === null && !error && <p className="muted">Loading decks…</p>}
        {preparing && <p className="preparing">Preparing your deck</p>}
        <div className="deck-grid">
          <label className={`deck-card upload-card${preparing ? ' is-busy' : ''}`}>
            <input
              type="file"
              accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              aria-label="Upload a PDF or PowerPoint"
              disabled={opening !== null || preparing}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void upload(file)
              }}
            />
            <span className="upload-mark" aria-hidden="true">+</span>
            <span className="deck-body">
              <strong>{preparing ? 'Preparing your deck' : 'Upload a deck'}</strong>
              <em>{preparing ? 'Reading the slides.' : 'PDF or PowerPoint, up to 6 slides'}</em>
            </span>
          </label>
          {decks?.map((deck) => (
            <button
              key={deck.id}
              type="button"
              className="deck-card"
              disabled={opening !== null || preparing}
              onClick={() => open(deck.id)}
            >
              <img src={deck.image} alt="" />
              <span className="deck-body">
                <strong>{deck.title}</strong>
                <em>{opening === deck.id ? 'Opening…' : `${deck.slideCount} slides`}</em>
                <span className="start">{opening === deck.id ? 'Opening…' : 'Start'}</span>
              </span>
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  )
}
