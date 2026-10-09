import { GoogleGenAI } from '@google/genai';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DeckSchema, getDeck, saveDeck, type Deck } from './deck.js';

const INGEST_PROMPT = `The images are slides in order. Return JSON with title, summary, and one entry per slide with number, title, keyPoints, and notes. notes are 60-120 words of what a presenter would say and know, including what any chart or diagram shows. Use only what is visible on the slides. keyPoints is an array of at most 6 short strings. Include one entry for every image, numbered from 1.`;

const IngestSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  slides: z.array(z.object({
    title: z.string().min(1),
    keyPoints: z.array(z.string()).max(6),
    notes: z.string().min(1),
  })).min(1).max(6),
});

function extension(name: string): 'pdf' | 'pptx' | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pptx')) return 'pptx';
  if (lower.endsWith('.pdf')) return 'pdf';
  return undefined;
}

function run(command: string, args: string[], timeout: number, home?: string): Promise<string> {
  return new Promise((resolveOut, reject) => {
    execFile(command, args, { timeout, env: home ? { ...process.env, HOME: home } : process.env }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        const detail = missing ? `${command} is not installed` : (stderr.toString().trim() || error.message);
        reject(new Error(`${command} failed: ${detail}`));
        return;
      }
      resolveOut(stdout.toString());
    });
  });
}

// Counted from the zip central directory so a file over 6 slides is rejected before any model call.
function countPptx(buffer: Buffer): number {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || buffer.readUInt32LE(eocd + 16) === 0xffffffff) {
    throw new Error('This .pptx file could not be read.');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let slides = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('This .pptx file could not be read.');
    }
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) slides += 1;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return slides;
}

async function countPdf(buffer: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'deck-pdf-'));
  try {
    const file = join(dir, 'upload.pdf');
    await writeFile(file, buffer);
    const stdout = await run('pdfinfo', [file], 30_000);
    const match = /^Pages:\s+(\d+)/m.exec(stdout);
    if (!match) throw new Error('This PDF could not be read.');
    return Number(match[1]);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('is not installed')) throw cause;
    throw new Error('This PDF could not be read.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function rasterize(buffer: Buffer, ext: 'pdf' | 'pptx'): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'deck-'));
  try {
    const input = join(dir, `upload.${ext}`);
    await writeFile(input, buffer);
    let pdf = input;
    if (ext === 'pptx') {
      // LibreOffice will not start in Docker unless it can write a user profile.
      await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, input], 60_000, dir);
      pdf = join(dir, 'upload.pdf');
    }
    await run('pdftoppm', ['-png', '-r', '110', pdf, join(dir, 'slide')], 60_000);
    const names = (await readdir(dir))
      .filter((name) => /^slide-\d+\.png$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
    return Promise.all(names.map((name) => readFile(join(dir, name))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function toDeck(raw: unknown, id: string, slideCount: number): Deck {
  const body = IngestSchema.parse(raw);
  if (body.slides.length !== slideCount) {
    throw new Error('The model returned a deck that does not match the slides.');
  }
  return DeckSchema.parse({
    id,
    title: body.title.trim(),
    summary: body.summary.trim(),
    slides: body.slides.map((slide, index) => ({
      number: index + 1,
      title: slide.title.trim(),
      keyPoints: slide.keyPoints.map((point) => point.trim()).filter(Boolean).slice(0, 6),
      notes: slide.notes.trim(),
      image: `/slides/${id}/slide-${index + 1}.png`,
    })),
  });
}

function parseDeck(text: string, id: string, slideCount: number): Deck {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new Error('The model returned a deck that does not match the slides.');
  }
  try {
    return toDeck(raw, id, slideCount);
  } catch {
    throw new Error('The model returned a deck that does not match the slides.');
  }
}

async function callModel(pngs: Buffer[], model: string, apiKey: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        ...pngs.map((data) => ({ inlineData: { mimeType: 'image/png', data: data.toString('base64') } })),
        { text: INGEST_PROMPT },
      ],
    }],
    config: { responseMimeType: 'application/json' },
  });
  if (!res.text) throw new Error('The model returned no deck.');
  console.log(`ingest model ${model} slides ${pngs.length}`);
  return res.text;
}

async function describe(pngs: Buffer[], id: string): Promise<Deck> {
  const apiKey = process.env.GOOGLE_API_KEY;
  const primary = process.env.GEMINI_INGEST_MODEL;
  const fallback = process.env.GEMINI_INGEST_FALLBACK_MODEL;
  if (!apiKey || !primary || !fallback) {
    throw new Error('GOOGLE_API_KEY, GEMINI_INGEST_MODEL, and GEMINI_INGEST_FALLBACK_MODEL are required');
  }

  let text: string;
  try {
    text = await callModel(pngs, primary, apiKey);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'primary model failed';
    console.log(`ingest primary failed ${message}`);
    return parseDeck(await callModel(pngs, fallback, apiKey), id, pngs.length);
  }
  try {
    return parseDeck(text, id, pngs.length);
  } catch (cause) {
    console.log(`ingest parse failed ${cause instanceof Error ? cause.message : 'parse'}`);
    try {
      return parseDeck(await callModel(pngs, primary, apiKey), id, pngs.length);
    } catch {
      return parseDeck(await callModel(pngs, fallback, apiKey), id, pngs.length);
    }
  }
}

export async function ingestUpload(buffer: Buffer, originalName: string): Promise<Deck> {
  const ext = extension(originalName);
  if (!ext) throw new Error('Upload a .pptx or .pdf file.');

  const id = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const cached = getDeck(id);
  if (cached) return cached;

  const declared = ext === 'pptx' ? countPptx(buffer) : await countPdf(buffer);
  if (declared > 6) throw new Error(`This file has ${declared} slides. The limit is 6.`);
  if (declared < 1) throw new Error('This file has no slides.');

  const pngs = await rasterize(buffer, ext);
  if (pngs.length > 6) throw new Error(`This file has ${pngs.length} slides. The limit is 6.`);
  if (pngs.length < 1) throw new Error('This file has no slides.');

  const deck = await describe(pngs, id);
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error('DATA_DIR is required');
  const dir = join(resolve(dataDir), 'slides', id);
  await mkdir(dir, { recursive: true });
  await Promise.all(pngs.map((png, index) => writeFile(join(dir, `slide-${index + 1}.png`), png)));

  const existing = getDeck(id);
  if (existing) return existing;
  try {
    saveDeck(deck, 'upload');
  } catch (cause) {
    const saved = getDeck(id);
    if (saved) return saved;
    throw cause;
  }
  return deck;
}
