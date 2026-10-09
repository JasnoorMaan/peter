export type Slide = {
  number: number
  title: string
  keyPoints: string[]
  notes: string
  image: string
}

export type Deck = {
  id: string
  title: string
  summary: string
  slides: Slide[]
}

export type DeckListItem = {
  id: string
  title: string
  slideCount: number
  image: string
}

export type Session = {
  token: string
  serverUrl: string
  roomName: string
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? fallback
}

export async function listDecks(): Promise<DeckListItem[]> {
  const response = await fetch('/api/decks')
  if (!response.ok) throw new Error(await readError(response, 'Could not load decks'))
  return response.json()
}

export async function getDeck(id: string): Promise<Deck> {
  const response = await fetch(`/api/decks/${id}`)
  if (!response.ok) throw new Error(await readError(response, 'Unknown deck'))
  return response.json()
}

export async function uploadDeck(file: File): Promise<Deck> {
  const body = new FormData()
  body.append('file', file)
  const response = await fetch('/api/decks', { method: 'POST', body })
  if (!response.ok) throw new Error(await readError(response, 'Could not prepare that deck'))
  return response.json()
}

export async function createSession(deckId: string): Promise<Session> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deckId }),
  })
  if (!response.ok) throw new Error(await readError(response, 'Could not start a session'))
  return response.json()
}
