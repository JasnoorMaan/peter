import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { getDeck, listDecks, seedDecks } from './deck.js';
import { ingestUpload } from './ingest.js';

const dataDir = process.env.DATA_DIR;
const livekitUrl = process.env.LIVEKIT_URL;
const livekitKey = process.env.LIVEKIT_API_KEY;
const livekitSecret = process.env.LIVEKIT_API_SECRET;
const agentName = process.env.AGENT_NAME;
if (!dataDir || !livekitUrl || !livekitKey || !livekitSecret || !agentName || !process.env.GOOGLE_API_KEY || !process.env.GEMINI_INGEST_MODEL || !process.env.GEMINI_INGEST_FALLBACK_MODEL) {
  const missing = ['DATA_DIR', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'AGENT_NAME', 'GOOGLE_API_KEY', 'GEMINI_INGEST_MODEL', 'GEMINI_INGEST_FALLBACK_MODEL'].filter(
    (name) => !process.env[name],
  );
  throw new Error(`${missing.join(', ')} required`);
}

seedDecks();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

app.get('/health', (_req, res) => {
  res.send('ok');
});

app.get('/api/decks', (_req, res) => {
  res.json(
    listDecks().map((deck) => ({
      id: deck.id,
      title: deck.title,
      slideCount: deck.slides.length,
      image: deck.slides[0].image,
    })),
  );
});

app.get('/api/decks/:id', (req, res) => {
  const id = req.params.id;
  const deck = typeof id === 'string' ? getDeck(id) : undefined;
  if (!deck) return res.status(404).json({ error: 'Unknown deck' });
  res.json(deck);
});

app.post('/api/session', async (req, res) => {
  const deckId = req.body?.deckId;
  if (typeof deckId !== 'string' || !getDeck(deckId)) {
    return res.status(404).json({ error: 'Unknown deck' });
  }

  const roomName = `deck-${deckId}-${randomUUID().slice(0, 8)}`;
  const at = new AccessToken(livekitKey, livekitSecret);
  at.identity = `viewer-${randomUUID().slice(0, 8)}`;
  at.addGrant({ roomJoin: true, room: roomName });
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName,
        metadata: JSON.stringify({ deckId }),
      }),
    ],
  });

  res.json({ token: await at.toJwt(), serverUrl: livekitUrl, roomName });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post('/api/decks', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
    res.status(400).json({ error: tooBig ? 'The file is larger than 20 MB.' : 'Upload a .pptx or .pdf file.' });
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Upload a .pptx or .pdf file.' });
    return;
  }
  try {
    res.json(await ingestUpload(file.buffer, file.originalname));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Could not prepare that deck';
    const status = /limit is 6|no slides|Upload a |could not be read/i.test(message) ? 400 : 500;
    console.log(`ingest failed ${message}`);
    res.status(status).json({ error: message });
  }
});

app.use('/slides', express.static(join(resolve(dataDir), 'slides')));

app.listen(3001);
