import { type JobContext, ServerOptions, cli, defineAgent, getJobContext, llm, voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DeckSchema, type Deck } from './deck.js';

for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'GOOGLE_API_KEY', 'GEMINI_LIVE_MODEL', 'API_URL']) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

function firstSeedDeckId(): string {
  const seedRoot = join(dirname(fileURLToPath(import.meta.url)), '../seed');
  const folders = readdirSync(seedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const id = folders[0];
  if (!id) throw new Error('No seed deck is available');
  return id;
}

function buildInstructions(deck: Deck): string {
  const slides = deck.slides
    .map((s) => `Slide ${s.number}: ${s.title}\nKey points: ${s.keyPoints.join('; ')}\nNotes: ${s.notes}`)
    .join('\n\n');

  return `You are Peter, presenting a slide deck called "${deck.title}" to one person, by voice. Speak English.

DECK
${slides}

HOW TO PRESENT
- Start on slide 1. Explain each slide in three or four spoken sentences using its notes. Do not read bullet points aloud.
- When you finish a slide, call go_to_slide for the next one and keep going. After the last slide, invite questions.
- Always call go_to_slide BEFORE you talk about a slide that is not on screen.

QUESTIONS AND INTERRUPTIONS
- If the user asks something, stop presenting and answer it.
- If the answer lives on a different slide, call go_to_slide for that slide first, then answer.
- After answering, ask whether to continue from where you left off.
- "Next", "back", and "go to slide N" are navigation commands: call go_to_slide and briefly introduce that slide.
- If the user says "this slide" or "here", call get_current_slide instead of guessing.
- If the question is not covered by the deck, say so in one sentence. Do not invent facts about the deck.

STYLE
- Short sentences. No lists, no markdown, no emoji. Sound like a person talking.`;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const metadata = JSON.parse(ctx.job.metadata || '{}') as { deckId?: unknown };
    let deckId = metadata.deckId;
    if (typeof deckId !== 'string' || !deckId) {
      deckId = firstSeedDeckId();
      console.log(`[${Date.now()}] no deckId in metadata; using seed deck ${deckId}`);
    }

    const deckUrl = `${process.env.API_URL}/api/decks/${deckId}`;
    const deckStarted = Date.now();
    const response = await fetch(deckUrl);
    console.log(`GET ${deckUrl} ${response.status} ${Date.now() - deckStarted}ms`);
    if (!response.ok) throw new Error(`Could not load deck ${deckId}: ${response.status}`);
    const deck = DeckSchema.parse(await response.json());
    const state = { current: 1 };

    const goToSlide = llm.tool({
      name: 'go_to_slide',
      description: 'Show a slide on the user\'s screen. Call this before talking about a slide that is not currently shown.',
      parameters: z.object({
        slideNumber: z.number().int().describe(`Slide to show, from 1 to ${deck.slides.length}`),
      }),
      execute: async ({ slideNumber }) => {
        const started = Date.now();
        console.log(`[${started}] go_to_slide execute start slide=${slideNumber}`);
        if (slideNumber < 1 || slideNumber > deck.slides.length) {
          console.log(`[${Date.now()}] go_to_slide failed invalid duration=${Date.now() - started}`);
          return `Invalid slide number. This deck has slides 1 to ${deck.slides.length}.`;
        }
        const room = getJobContext().room;
        const local = room.localParticipant;
        const viewer = Array.from(room.remoteParticipants.values())[0];
        if (!local || !viewer) {
          console.log(`[${Date.now()}] go_to_slide failed no viewer duration=${Date.now() - started}`);
          return 'The viewer is not in the room yet.';
        }
        const sent = Date.now();
        console.log(`[${sent}] go_to_slide RPC sent to=${viewer.identity} timeout=default`);
        try {
          await local.performRpc({
            destinationIdentity: viewer.identity,
            method: 'showSlide',
            payload: JSON.stringify({ slideNumber }),
          });
          console.log(`[${Date.now()}] go_to_slide RPC returned duration=${Date.now() - sent} total=${Date.now() - started}`);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'RPC failed';
          console.log(`[${Date.now()}] go_to_slide RPC failed ${message} duration=${Date.now() - sent} total=${Date.now() - started}`);
          return `Could not change the slide: ${message}`;
        }
        state.current = slideNumber;
        return `Now showing slide ${slideNumber}: ${deck.slides[slideNumber - 1].title}`;
      },
    });

    const getCurrentSlide = llm.tool({
      name: 'get_current_slide',
      description: 'Returns which slide is on screen right now. Call this when the user says "this slide" or "here".',
      parameters: z.object({}),
      execute: async () => {
        const started = Date.now();
        const result = `Slide ${state.current}: ${deck.slides[state.current - 1].title}`;
        console.log(`get_current_slide ${Date.now() - started}ms`);
        return result;
      },
    });

    const session = new voice.AgentSession({
      // Gemini Live detects speech itself. The session would otherwise load a local VAD and a turn detector.
      vad: null,
      turnHandling: {
        turnDetection: 'realtime_llm',
        // A slow transcript was resuming the old reply after 2s and treating a real interruption as a false one.
        interruption: { resumeFalseInterruption: false },
      },
      llm: new google.realtime.RealtimeModel({
        model: process.env.GEMINI_LIVE_MODEL,
        voice: 'Puck',
        // An empty language code made the console transcribe English as Hindi.
        language: 'en-US',
        // gemini-3.8-live rejects a thinking level, so none is sent.
        // BLOCKING makes the model wait for each tool result before it continues.
        toolBehavior: google.realtime.Behavior.BLOCKING,
      }),
    });

    let presenting = true;
    let sawSpeech = false;
    let nudgedSlide = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;

    function clearIdle() {
      if (!idle) return;
      clearTimeout(idle);
      idle = undefined;
    }

    // Gemini Live sometimes ends the turn after go_to_slide. One nudge per slide keeps the walkthrough moving.
    function armIdle() {
      clearIdle();
      if (!presenting || !sawSpeech || state.current >= deck.slides.length) return;
      idle = setTimeout(() => {
        idle = undefined;
        if (!presenting || state.current >= deck.slides.length) return;
        const agentState = session.agentState;
        if (agentState === 'speaking' || agentState === 'thinking') return;
        if (nudgedSlide === state.current) return;
        nudgedSlide = state.current;
        console.log(`[${Date.now()}] idle nudge from slide ${state.current}`);
        try {
          session.generateReply({ instructions: 'Continue with the next slide.' });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : 'error';
          console.log(`[${Date.now()}] idle nudge failed ${message}`);
        }
      }, 2000);
    }

    function resumeWalkthrough(transcript: string): boolean {
      const text = transcript.trim().toLowerCase().replace(/[.!?]+$/g, '');
      return /^(yes|yeah|yep|sure|ok|okay|continue|go on|keep going|carry on|please|yes please|go ahead)$/.test(text)
        || /\b(continue|keep going|carry on)\b/.test(text);
    }

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      console.log(`[${Date.now()}] user state ${ev.oldState} -> ${ev.newState}`);
      if (ev.newState === 'speaking') {
        console.log(`[${Date.now()}] user speech detected agentState=${session.agentState}`);
        clearIdle();
      }
    });
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      console.log(`[${Date.now()}] user transcript final=${ev.isFinal} ${JSON.stringify(ev.transcript)}`);
      if (!ev.isFinal) return;
      const text = ev.transcript.trim();
      // Speaker echo can mark the user as speaking without a transcript. Only a real transcript pauses or resumes.
      if (!/[a-z0-9]/i.test(text)) return;
      presenting = resumeWalkthrough(text);
      if (presenting) nudgedSlide = 0;
      else clearIdle();
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[${Date.now()}] agent state ${ev.oldState} -> ${ev.newState}`);
      if (ev.newState === 'speaking') sawSpeech = true;
      if (ev.newState === 'listening' || ev.newState === 'idle') armIdle();
      else clearIdle();
    });
    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      console.log(`[${Date.now()}] speech created source=${ev.source} userInitiated=${ev.userInitiated}`);
    });
    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, (ev) => {
      console.log(`[${Date.now()}] interruption false resumed=${ev.resumed}`);
    });
    session.on(voice.AgentSessionEventTypes.OverlappingSpeech, () => {
      console.log(`[${Date.now()}] interruption overlapping speech`);
    });
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const metrics = ev.metrics;
      if (metrics.type === 'realtime_model_metrics') {
        console.log(`[${Date.now()}] metrics ttft=${metrics.ttftMs} duration=${metrics.durationMs} in=${metrics.inputTokens} out=${metrics.outputTokens} reasoning=${metrics.reasoningTokens ?? 'none'} cancelled=${metrics.cancelled}`);
      } else if (metrics.type === 'interruption_metrics') {
        console.log(`[${Date.now()}] interruption metrics ${metrics.totalDuration}`);
      }
    });
    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      const cause = ev.error;
      const message = cause instanceof Error ? cause.message : 'error' in cause && cause.error instanceof Error ? cause.error.message : String(cause);
      console.log(`[${Date.now()}] session error ${message}`);
    });
    session.on(voice.AgentSessionEventTypes.Close, () => {
      presenting = false;
      clearIdle();
    });

    await session.start({
      agent: voice.Agent.create({
        instructions: buildInstructions(deck),
        tools: [goToSlide, getCurrentSlide],
      }),
      room: ctx.room,
    });
    await ctx.connect();

    const participant = ctx.room.localParticipant;
    if (!participant) throw new Error('Agent is not in the room');
    participant.registerRpcMethod('userChangedSlide', async (data) => {
      const started = Date.now();
      let slideNumber = Number.NaN;
      try {
        slideNumber = JSON.parse(data.payload).slideNumber;
      } catch {
        console.log(`userChangedSlide invalid ${Date.now() - started}ms`);
        return 'invalid payload';
      }
      if (!Number.isInteger(slideNumber) || slideNumber < 1 || slideNumber > deck.slides.length) {
        console.log(`userChangedSlide ${slideNumber} rejected ${Date.now() - started}ms`);
        return `Invalid slide number. This deck has slides 1 to ${deck.slides.length}.`;
      }
      state.current = slideNumber;
      presenting = false;
      clearIdle();
      console.log(`userChangedSlide ${slideNumber} ${Date.now() - started}ms`);
      return 'ok';
    });

    const reply = 'Greet the user in one English sentence, introduce yourself as Peter, call go_to_slide for slide 1, and start presenting that slide.';
    console.log(`[${Date.now()}] generateReply ${JSON.stringify(reply)}`);
    session.generateReply({ instructions: reply });
  },
});

// The job process imports this file. Only the process started as this file should run the worker.
const launchedAs = process.argv[1];
if (launchedAs && resolve(launchedAs) === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.AGENT_NAME ?? 'slide-presenter',
  }));
}
