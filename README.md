# peter

A voice agent that presents a short slide deck, can navigate through slides, handle questions about the presentation

## Quick start

1. Copy `.env.example` to `.env`.
2. Fill in `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `GOOGLE_API_KEY`. The model IDs in the example are the ones this repo runs. Copy them from AI Studio if a name there differs from the API id.
3. `AGENT_NAME` must be the same name the LiveKit worker registers. The token dispatches that name. The voice model is `GEMINI_LIVE_MODEL` (`gemini-3.8-live`). Ingestion uses `GEMINI_INGEST_MODEL` (`gemini-3.8-flash`), and if that call fails, `GEMINI_INGEST_FALLBACK_MODEL` (`gemini-3.5-flash-lite`).
4. Start the app:

```
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000).

To work on the code without Compose, run three processes: `npm run dev:api` and `npm run dev:agent` in `server/`, and `npm run dev` in `client/`. Upload on the host also needs LibreOffice (`soffice`) and poppler (`pdfinfo`, `pdftoppm`). The server image already has both.

## Architecture

Every new pptx uploaded goes through 6 slide max validation and then a libreoffice process of converting it into a pdf then a process to convert it into images/slide. A pdf skips LibreOffice and is rasterized straight to images. The images get sent to the gemini model to return a json output of the form:

```json
{
  "title": "deck title",
  "summary": "what the deck is about",
  "slides": [
    {
      "title": "slide title",
      "keyPoints": ["short point"],
      "notes": "60 to 120 words of what a presenter would say, including what any chart shows"
    }
  ]
}
```

which has the description of the slides. The prompt asks for 60 to 120 words of notes. The schema only requires notes to be non-empty, and it checks that the model returned one entry per image. The server adds the deck id, a number on each slide, and the image path before saving:

```json
{
  "id": "90b60beacfd3",
  "title": "deck title",
  "summary": "what the deck is about",
  "slides": [
    {
      "number": 1,
      "title": "slide title",
      "keyPoints": ["short point"],
      "notes": "60 to 120 words",
      "image": "/slides/90b60beacfd3/slide-1.png"
    }
  ]
}
```

We store that json in sqlite. The pngs sit on disk under `DATA_DIR/slides/<id>/`, and the `image` field is the URL the browser loads.

Starting a presentation mints a LiveKit token that carries the deck id and dispatches the agent. The agent joins the room, loads the deck with `GET /api/decks/:id`, and puts that JSON in the live model's prompt. The prompt asks the model to call `go_to_slide` in these cases:

- The greeting, which starts on slide 1.
- Finishing a slide and moving to the next one. After the last slide it invites questions instead.
- An answer that lives on a different slide. The tool runs before the answer.
- "Next", "back", and "go to slide N".

An idle nudge, about two seconds after the model stops mid-walkthrough, calls `generateReply` with "Continue with the next slide." The nudge does not call `go_to_slide` itself. The model may call the tool on the next turn, once per slide.

The browser renders the current slide, captures the mic, and plays Peter. It exposes a `showSlide` RPC method for the agent. An arrow click updates the image on the page immediately, then tells the agent.

The API process owns decks. It seeds the database, serves slide images, accepts uploads, and mints a LiveKit token. The token creates a new room and dispatches the agent with the deck id.

The agent process joins that room, loads the deck from the API, and talks. When the model changes slides, that is a `go_to_slide` tool call. The tool calls `showSlide` on the browser over LiveKit RPC and waits for `ok` before the model continues. Arrow clicks do not use that tool. The browser sends `userChangedSlide`, and the agent stores the new number.

LiveKit Cloud carries the WebRTC audio. Gemini Live does the listening, the reply, and the speech. A separate Gemini call runs only when someone uploads a deck.

### Database

One SQLite file, `DATA_DIR/decks.sqlite`. One table. A deck is one row, read and written whole.

```sql
CREATE TABLE decks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  source      TEXT NOT NULL,
  slides_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

`id` is the seed folder name, or the first 12 hex characters of an upload's SHA-256. `source` is `seed` or `upload`. `slides_json` is the stored document above, one to six slides, at most six key points each. `created_at` is an ISO-8601 timestamp. Uploading the same bytes again hits that id and returns the stored row without calling the model. That check is in the API, before any Gemini call.

## Design decisions

While starting this, Im a little biased to use Livekit for voice agent because of my experience and I used SQLite as DB, as I wanted these layers to be as minimal as possible and have to deal with less variables.

Speech-to-speech instead of a recognizer, a text model, and a voice engine pipeline. One Gemini Live model and one Google API key, so the reply can start while the person is still being heard. LiveKit has its own key pair and carries the audio, because building that transport was out of scope and the agent's reliability was the requirement. The cost is that the recognizer and the voice cannot be swapped on their own.

A model slide change is a tool call forwarded to the browser over RPC, because RPC returns an acknowledgement. The model is only told the slide is showing after the browser has it.

The agent is meant to own the current slide, with the browser drawing what it is told and reporting arrow clicks back. In this build the arrows paint before the agent agrees, so the two copies can diverge. That gap is under Known limitations.

Each deck is one JSON document. Decks are always read and written whole. A slides table would matter if a slide needed its own edit or a search across decks.

Ingestion runs once at upload. Nothing slow sits in the voice loop. The whole deck goes in the prompt, because six slides fit.

The client and the server are two projects. The client declares its own `Deck` type. Nothing in one project imports the other.

## Known limitations

Ingest runs inside the upload request. A `.pptx` is converted with LibreOffice and then rasterized in the API process, the file is held in memory, and one request can make as many as three Gemini calls: the primary model, one retry after a parse failure, then the fallback. There is no queue, so two converts share that process. A job queue with real failure handling is the improvement.

The API does not check who is calling. Port 3001 is published, and nginx on port 3000 proxies the same routes. Listing decks, reading speaker notes, downloading the PNGs, uploading a file, and minting a room token are all open. The page fetches the full deck, notes included, even though it only draws the image and the title.

Titles and notes are concatenated into the system prompt, so text on a slide can instruct the voice agent.

On the Gemini free tier, describing a new deck with Gemini 3.8 Flash is about twenty requests a day, and the lite fallback is about five hundred. This app does not enforce either number. Both results have to match the deck schema, not merely parse as JSON. Uploading the same bytes again does not spend a request. That cache is the hash described under Database.

The walkthrough is a boolean plus a regex in the agent process, not a mode the model owns. A final transcript with no letters or digits is ignored. Any other final transcript that is not `yes`, `ok`, `continue`, or a close variant sets `presenting` to false and cancels the idle timer. "Next", "back", and "go to slide N" still call `go_to_slide` once, because that is in the prompt, and then the same transcript takes the agent out of the walkthrough. Saying yes, or asking to continue, is what puts it back. The timer is a patch for a separate failure: Gemini Live often ends the turn after `go_to_slide`, so two seconds later the process calls `generateReply` with "Continue with the next slide", once per slide. If that nudge is ignored, Peter waits.

The slide number is `state.current` in that same process, and it starts at 1. A reload, an agent restart, or a new room starts the story over. The arrows paint the new image immediately and then send `userChangedSlide`. That RPC updates the number and stops the walkthrough. It does not tell the model, so Peter can keep talking about the previous slide. If the RPC fails, the screen and `get_current_slide` disagree. `go_to_slide` delivers `showSlide` to `remoteParticipants[0]`, which is the right person only while the room has one human in it. A job whose dispatch metadata has no `deckId` presents the first seed deck instead of failing.

Browser echo cancellation usually stops Peter's voice re-entering the mic, so laptop speakers often work. When it loses, the agent can hear itself and stop. The code only drops a transcript that contains no letters or digits, because echo can mark the user as speaking without real words. `resumeFalseInterruption` is off because a late transcript was restarting the sentence he had already been saying.

## What I would do next

When I remake it, I would do these to improve:

Give the session an explicit mode, presenting or answering, and change it from the tool result and from a classified intent. After a successful `go_to_slide` the tool result should tell the model to keep speaking, and "next" should stay in presenting. The regex and the one-shot nudge are there because the turn currently ends on its own. Store the slide number on the LiveKit room and have both sides read it. Paint the image when `showSlide` returns, and have `userChangedSlide` ask the model to introduce the slide the person just picked. A reconnect should restore the number. Address the RPC to the viewer identity on the token, and fail the job when `deckId` is missing.

Close the API. Mint a token for a known user, leave notes on the server, and sign the image URLs. Move ingest to a queue with a single LibreOffice worker so a convert cannot block the process that serves decks. Put the deck text in a delimited block the model is told to treat as data.

Add evals for the agent (never made them before, would have to study it), and test the parts that are already pure functions: the 6-slide rejection, the content-hash cache, the resume phrases, and the RPC payload checks. Export nudge rate, RPC failures, and time to first token instead of printing them.

If tool calls still drop the slide change after the mode is explicit, replace Gemini Live with a recognizer, a text model, and a voice engine. That is a new session setup. The blocking tool behavior, the interruption setting, and the idle nudge exist because this session is a live model, so they would be rewritten with it.
