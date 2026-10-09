import {
  RoomAudioRenderer,
  RoomContext,
  useRoomContext,
  useTranscriptions,
  useVoiceAssistant,
} from '@livekit/components-react'
import { ParticipantEvent, Room, RoomEvent, type RpcInvocationData } from 'livekit-client'
import { useEffect, useRef, useState } from 'react'
import { type Deck, type Session } from '../api'

function spokenLines(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : []
}

const stateLabel: Record<string, string> = {
  disconnected: 'Connecting',
  connecting: 'Connecting',
  'pre-connect-buffering': 'Connecting',
  initializing: 'Getting ready',
  idle: 'Here',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  failed: 'Connection failed',
}

export function Presenter({
  deck,
  session,
  onEnd,
}: {
  deck: Deck
  session: Session
  onEnd: () => void
}) {
  const [room] = useState(() => new Room())
  const [currentSlide, setCurrentSlide] = useState(1)
  const [connectError, setConnectError] = useState<string | null>(null)
  const slideCount = useRef(deck.slides.length)
  slideCount.current = deck.slides.length

  useEffect(() => {
    for (const slide of deck.slides) {
      const image = new Image()
      image.src = slide.image
    }
  }, [deck])

  useEffect(() => {
    let gone = false
    let registered = false
    const onConnected = () => {
      room.registerRpcMethod('showSlide', async (data: RpcInvocationData) => {
        console.log(`[${Date.now()}] client showSlide entered`)
        const { slideNumber } = JSON.parse(data.payload) as { slideNumber: number }
        if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > slideCount.current) {
          console.log(`[${Date.now()}] client showSlide returned invalid`)
          return 'invalid'
        }
        setCurrentSlide(slideNumber)
        console.log(`[${Date.now()}] client showSlide returned`)
        return 'ok'
      })
      registered = true
    }
    room.on(RoomEvent.Connected, onConnected)
    room
      .connect(session.serverUrl, session.token)
      .then(() => {
        if (!gone) return room.localParticipant.setMicrophoneEnabled(true)
      })
      .catch((cause: unknown) => {
        if (gone) return
        const message = cause instanceof Error ? cause.message : 'Could not connect'
        setConnectError(
          /permission/i.test(message)
            ? 'Microphone permission was denied. Allow the mic to talk to the presenter.'
            : message,
        )
      })
    return () => {
      gone = true
      room.off(RoomEvent.Connected, onConnected)
      if (registered) room.unregisterRpcMethod('showSlide')
      room.disconnect()
    }
  }, [room, session.serverUrl, session.token])

  return (
    <RoomContext.Provider value={room}>
      <RoomAudioRenderer />
      <RoomGate
        deck={deck}
        currentSlide={currentSlide}
        onSlide={setCurrentSlide}
        onEnd={() => {
          room.disconnect()
          onEnd()
        }}
        connectError={connectError}
      />
    </RoomContext.Provider>
  )
}

function RoomGate({
  deck,
  currentSlide,
  onSlide,
  onEnd,
  connectError,
}: {
  deck: Deck
  currentSlide: number
  onSlide: (slideNumber: number) => void
  onEnd: () => void
  connectError: string | null
}) {
  const { agent } = useVoiceAssistant()
  const [joined, setJoined] = useState(false)

  useEffect(() => {
    if (agent) setJoined(true)
  }, [agent])

  if (!joined) return <Reading error={connectError} onEnd={onEnd} />

  return (
    <Stage
      deck={deck}
      currentSlide={currentSlide}
      onSlide={onSlide}
      onEnd={onEnd}
      connectError={connectError}
    />
  )
}

function Reading({ error, onEnd }: { error: string | null; onEnd: () => void }) {
  return (
    <main className="reading">
      <div className="lamp lamp-mind" aria-hidden="true">
        <span className="blob blob-a" />
        <span className="blob blob-b" />
        <span className="blob blob-c" />
        <span className="blob blob-d" />
      </div>
      <div className="reading-copy">
        <h1>Peter is reading your slides.</h1>
        <p className="lede">He will be up in a jiff.</p>
        {error && <p className="error">{error}</p>}
        <button type="button" className="text-button" onClick={onEnd}>
          End session
        </button>
      </div>
    </main>
  )
}

function Stage({
  deck,
  currentSlide,
  onSlide,
  onEnd,
  connectError,
}: {
  deck: Deck
  currentSlide: number
  onSlide: (slideNumber: number) => void
  onEnd: () => void
  connectError: string | null
}) {
  const room = useRoomContext()
  const { state, agent } = useVoiceAssistant()
  const transcriptions = useTranscriptions()
  const [navNote, setNavNote] = useState<string | null>(null)
  const lastTranscript = useRef('')
  const transcriptRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    console.log(`[${Date.now()}] client agent state ${state}`)
  }, [state])

  useEffect(() => {
    const onSpeaking = (speaking: boolean) => {
      if (speaking) console.log(`[${Date.now()}] client user speech detected`)
    }
    room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, onSpeaking)
    return () => {
      room.localParticipant.off(ParticipantEvent.IsSpeakingChanged, onSpeaking)
    }
  }, [room])

  useEffect(() => {
    const line = transcriptions.at(-1)
    if (!line) return
    const key = `${line.participantInfo.identity}:${line.text}`
    if (key === lastTranscript.current) return
    lastTranscript.current = key
    const who = line.participantInfo.identity === room.localParticipant.identity ? 'user' : 'agent'
    console.log(`[${Date.now()}] client transcript ${who} ${line.text}`)
  }, [transcriptions, room])

  const rows = transcriptions.flatMap((item, index) => {
    const speaker = item.participantInfo.identity === room.localParticipant.identity ? 'You' : 'Presenter'
    return spokenLines(item.text).map((text, part) => ({
      key: `${item.participantInfo.identity}-${index}-${part}`,
      speaker,
      text,
    }))
  })
  const latest = rows.at(-1)
  const latestKey = latest ? `${latest.key}:${latest.text}` : ''

  useEffect(() => {
    const el = transcriptRef.current
    if (!el || !latestKey) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }, [latestKey])

  const slide = deck.slides.find((item) => item.number === currentSlide) ?? deck.slides[0]

  async function show(slideNumber: number) {
    onSlide(slideNumber)
    setNavNote(null)
    if (!agent) return
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: 'userChangedSlide',
        payload: JSON.stringify({ slideNumber }),
      })
    } catch {
      setNavNote('The presenter missed that. Try the arrow again.')
    }
  }

  return (
    <main className="stage">
      <div className="lamp lamp-corner" data-state={state} aria-hidden="true">
        <span className="blob blob-a" />
        <span className="blob blob-b" />
        <span className="blob blob-c" />
      </div>
      <header className="stage-bar">
        <p className="eyebrow">{deck.title}</p>
        <button type="button" className="text-button" onClick={onEnd}>
          End session
        </button>
      </header>
      <figure className="slide-frame arrive">
        <img src={slide.image} alt={slide.title} />
      </figure>
      <div className="transport">
        <button type="button" aria-label="Previous slide" disabled={slide.number <= 1} onClick={() => show(slide.number - 1)}>
          Back
        </button>
        <div className="dots">
          {deck.slides.map((item) => (
            <button
              key={item.number}
              type="button"
              className="dot"
              aria-label={`Slide ${item.number}: ${item.title}`}
              aria-current={item.number === slide.number ? 'true' : undefined}
              onClick={() => show(item.number)}
            />
          ))}
        </div>
        <button
          type="button"
          aria-label="Next slide"
          disabled={slide.number >= deck.slides.length}
          onClick={() => show(slide.number + 1)}
        >
          Next
        </button>
      </div>
      <footer className="stage-foot">
        <p className="status">{stateLabel[state] ?? state}</p>
        <div className="transcript" ref={transcriptRef}>
          {rows.length === 0 ? (
            <p className="transcript-line">Waiting for the first words.</p>
          ) : (
            rows.map((row, index) => (
              <p key={row.key} className={index === rows.length - 1 ? 'transcript-line is-latest' : 'transcript-line'}>
                <span>{row.speaker}</span>
                {row.text}
              </p>
            ))
          )}
        </div>
      </footer>
      {connectError && <p className="error">{connectError}</p>}
      {navNote && <p className="error">{navNote}</p>}
    </main>
  )
}
