import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// better-sqlite3 is CommonJS `export =`. A default import needs esModuleInterop, which this project does not turn on.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as new (filename: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

export const SlideSchema = z.object({
  number: z.number().int().min(1).max(6),
  title: z.string().min(1),
  keyPoints: z.array(z.string()).max(6),
  notes: z.string().min(1), // facts and talking points, not a script; 60-120 words
  image: z.string(), // URL path, e.g. /slides/<deckId>/slide-1.png
});

export const DeckSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  slides: z.array(SlideSchema).min(1).max(6),
});

export type Deck = z.infer<typeof DeckSchema>;

type DeckRow = { slides_json: string };

function dataRoot(): string {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error('DATA_DIR is required');
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  return root;
}

function openDb() {
  const db = new Database(join(dataRoot(), 'decks.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS decks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    source      TEXT NOT NULL,
    slides_json TEXT NOT NULL,
    created_at  TEXT NOT NULL
  )`);
  return db;
}

export function listDecks(): Deck[] {
  const db = openDb();
  const rows = db.prepare('SELECT slides_json FROM decks ORDER BY created_at, rowid').all() as DeckRow[];
  db.close();
  return rows.map((row) => DeckSchema.parse(JSON.parse(row.slides_json)));
}

export function getDeck(id: string): Deck | undefined {
  const db = openDb();
  const row = db.prepare('SELECT slides_json FROM decks WHERE id = ?').get(id) as DeckRow | undefined;
  db.close();
  return row ? DeckSchema.parse(JSON.parse(row.slides_json)) : undefined;
}

export function saveDeck(deck: Deck, source: 'seed' | 'upload'): void {
  const parsed = DeckSchema.parse(deck);
  const db = openDb();
  db.prepare(
    'INSERT INTO decks (id, title, source, slides_json, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(parsed.id, parsed.title, source, JSON.stringify(parsed), new Date().toISOString());
  db.close();
}

export function seedDecks(): void {
  const seedRoot = join(dirname(fileURLToPath(import.meta.url)), '../seed');
  const folders = readdirSync(seedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const folderName of folders) {
    const folder = join(seedRoot, folderName);
    const deck = DeckSchema.parse(JSON.parse(readFileSync(join(folder, 'deck.json'), 'utf8')));
    if (deck.id !== folderName) {
      throw new Error(`Seed folder ${folderName} contains deck id ${deck.id}`);
    }

    const slidesDir = join(dataRoot(), 'slides', deck.id);
    mkdirSync(slidesDir, { recursive: true });
    for (const slide of deck.slides) {
      const fileName = `slide-${slide.number}.png`;
      const image = `/slides/${deck.id}/${fileName}`;
      if (slide.image !== image) {
        throw new Error(`Seed slide ${deck.id} ${slide.number} image must be ${image}`);
      }
      const dest = join(slidesDir, fileName);
      if (!existsSync(dest)) copyFileSync(join(folder, fileName), dest);
    }

    if (!getDeck(deck.id)) saveDeck(deck, 'seed');
  }
}
