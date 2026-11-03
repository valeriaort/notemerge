# Audio upload fails after the first lecture with audio

**Date:** 2026-11-03
**Status:** Diagnosed, fix tracked in #60, #61, #62
**Severity:** High. Blocks every new lecture with audio once any earlier lecture has audio.

## Symptoms

1. A user uploaded presentation, audio and notes for a new untimed lecture on Sources. The UI stayed stuck (it looked like transcription never started).
2. In a new session, with the earlier tabs still open, uploading the same files failed with "Upload failed. Please try again."
3. No dev server was running afterwards.

## Root cause

Audio chunk IDs are unique only **within one lecture**, but they are stored in a table whose primary key covers **all lectures**.

- `chunkAudioFile` names chunks `A01-C001`, `A01-C002`, … (`src/server/chunking.ts:77`).
- `audio_chunks.id` is `TEXT PRIMARY KEY` across the whole database.
- Lecture `4675efad-…` (uploaded 2026-11-01) already owns `A01-C001`. The next lecture's first chunk insert fails:

```
SqliteError: UNIQUE constraint failed: audio_chunks.id
  at createAudioChunk (src/server/db.ts:716)
  at src/server/routes/audio.ts:300
```

Each API test starts with a new database holding only one lecture with audio, so this case was never exercised.

## Why it looked like a hang and then a crash

Two more defects turned a 4xx/5xx-worthy failure into a frozen UI and a dead server:

- **Async errors are not handled (#62).** The upload route is an `async` Express 4 handler. Express 4 doesn't catch rejected promises, so the request never got a response (the stuck UI). On Node 22 the unhandled rejection crashed the process (the dead server, then "Upload failed" in every tab).
- **Phase 2 of the upload isn't atomic (#61).** Database writes for the upload run without a transaction. The `audio_files` row for audio 1 was inserted just before the chunk insert threw, and it was never rolled back.

## Evidence (lecture `a50f99a6-15e6-4c3e-8e22-3a4debc57439`)

| Where | State |
| --- | --- |
| Disk | `audio1.m4a`, `audio2.m4a`, `chunks_A01/`, `chunks_A02/`, `presentation.pdf`, `slides.json` all written |
| `lectures` | stage `writing`, mode `untimed`, not sealed |
| `audio_files` | 1 row (index 1). No row for audio 2 |
| `audio_chunks` | 0 rows |
| `transcript_runs` | 0 rows |

## Reproduction

Regression test added to `tests/api/audio.test.ts`:

```
npx vitest run tests/api/audio.test.ts -t "multiple lectures"
```

It creates two lectures in the same database and uploads audio to both. It fails with the error above (about 5 s).

## Fix plan

| Issue | Change |
| --- | --- |
| #60 | Make chunk IDs unique across lectures (chunk file names on disk unchanged). Makes the regression test pass. |
| #61 | Run phase 2 of the upload in one transaction, and replace leftover audio rows when a not-yet-sealed lecture is uploaded again. |
| #62 | Send async route errors to an error middleware that returns `500 { error }` JSON, so failures show a message instead of hanging the UI and crashing the server. |

#60 alone unblocks uploads. #61 and #62 keep the next failure from leaving a corrupt lecture or killing the server.

## Recovering the stuck lecture

After #61, upload the files to lecture `a50f99a6-…` again. Its orphan `audio_files` row will be replaced. Until then, either start a new lecture once #60 is in, or delete the orphan row by hand:

```sql
DELETE FROM audio_files WHERE lecture_id = 'a50f99a6-15e6-4c3e-8e22-3a4debc57439';
```

## What would have prevented it

- Database-wide uniqueness for IDs that are only unique per lecture: generate globally unique IDs and keep human-readable labels (`A01-C001`) as display or file names only.
- No API test covered more than one lecture with audio in the same database.
- No safety net for errors in async handlers, so one database error took down the whole server.
