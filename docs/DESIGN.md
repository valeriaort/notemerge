# NoteMerge: settled design

Decisions reached in the grilling session. Vocabulary lives in `../CONTEXT.md` (glossary only); this file records behaviour and rationale. Source brief: `Product Description.pdf`.

## Scope

- Single user, local app (local web server, BlockNote front end). API keys live in a local config.
- Stack: TypeScript end to end. React with BlockNote on the front end; a local Node HTTP server that also serves it; SQLite for structured data and the file system for audio, chunks and PDFs (one folder per lecture); ffmpeg as a child process; a Node PDF library exposing font sizes and positions; Schwartz-Hearst reimplemented in TypeScript and tested against its public reference implementation. Jev, Groq, Haiku and Notion sit behind interfaces; the test seam is the server API.
- The data model keeps a user concept internally (the abbreviation dictionary is per user) so accounts could be added later.
- Everything is kept per lecture: notes, presentation, audio, transcript, merged note, final note. No automatic deletion.

## Lecture and uploads

- A lecture is one class session: one notes document, at most one presentation, at most one audio recording (up to two files, about 90-100 minutes total in practice).
- Notes are written in BlockNote before any subject is chosen; the subject is picked (or created with "+ new subject") at upload.
- Valid uploads: notes + presentation; notes + presentation + audio; notes + audio. Notes alone are rejected at upload. A presentation without notes is not offered.
- Presentation: PDF, 60+ pages, text only (images ignored). Each slide is enumerated (`S013`) and each bullet (`S013-B02`).
- Bullet extraction is deterministic (no LLM): text per page in reading order; lines repeating on more than about 50% of pages and bare page numbers are dropped; the largest-font top line is the slide title, stored but not a bullet; a line starting with a bullet glyph or number starts a new bullet, other lines join the previous bullet while it lacks terminal punctuation; nesting is flattened. A slide with no text has no bullets (its window is judged from the transcript only, labeled by slide number). A PDF with no extractable text on most pages is rejected as scanned images; OCR is out of scope.

## Time model

- Notes record wall-clock time (Europe/Madrid) at creation and edit. A note block's first-edit time places it in a slide window; last-edit time is stored but never used for placement.
- Notes are sealed (read-only) at upload. All later changes happen on the merged note.
- The user enters the recording start time for every audio file. A second file is a continuation after a break, never chained automatically. File creation time is not trusted.
- If the start time is unknown, the user may align one recognizable audio moment with a slide marker (e.g. audio 04:20 = marker 09:14:20, so start is about 09:10:00).
- Chunk clock time = recording start time + elapsed audio time.

## Note block identity

- One editor block = one note block; nested children are separate blocks. The ID is stored in the document, assigned at creation, never recomputed.
- First-edit time is the first keystroke that gave the block content (an empty block has none). Last-edit time updates on every content change.
- Split (Enter mid-block): the first half keeps the ID and times; the second half is a new block with first-edit time = split time.
- Merge (boundary deleted): the upper block's ID and first-edit time survive; the lower block's ID is retired.
- Paste: new IDs, first-edit time = paste time. Move: ID and first-edit time unchanged, so a move never changes the window.

## Slide markers and windows

- The student types `//` at each slide transition; it is saved as a timestamped event.
- A slide window runs from one marker's timestamp to the next, so windows tile the lecture with no gaps. An empty window (nothing written) is still a window.
- A marker means "the next slide starts now": the first `//` is the transition from slide 1 to slide 2. N markers give N+1 windows. Lecture start = earliest of the first note block's first-edit time and the first audio file's recording start time; lecture end = latest of the last note edit and the last audio file's end. Window 1 starts at lecture start, the last window ends at lecture end. A marker typed right at lecture start yields an empty window 1 that is dropped.
- Windows map to slides sequentially by default (window n = slide n). The user can reassign, merge, or delete windows by hand; a slide may span several windows and a window several slides.
- Without a presentation, typed markers still bound windows (labeled by number). Without markers, fixed 4-minute windows are used.
- A transcript sentence belongs to the window containing its start time (clock start from the Whisper segment timestamps within its chunk).
- Context margin (configurable constant, default 1 minute): notes and transcript are also retrieved 1 minute before and after the window, as context only. Only items inside the window are judged, so each item is flagged at most once. The margin applies to both the coverage check and the conflict check.

## Abbreviations and glossaries

- Abbreviation dictionary: personal, user-level, `abbreviation → expansion` (e.g. PTeLi, ATM, tto, pc, msc). Whole-word matching with case rules. Applied only to copies fed to the transcription prompt and to Jev; note blocks are never rewritten. Unknown short tokens are surfaced at upload for the student to define.
- Abbreviation matching rules: whole tokens split on whitespace and punctuation (`pc` never matches inside `pcr`); case-insensitive by default, with an optional per-pair "match case exactly" flag; the expansion follows the matched token's capitalisation (`Pc` at a sentence start gives `Paciente`); multi-token abbreviations are matched longest first. At upload, unknown tokens are listed when they are absent from the dictionary and the subject glossary, are not an ordinary Spanish word (bundled word list), and are at most 5 characters or all-caps; they are ranked by frequency in the notes, and the student can define, ignore, or ignore permanently (stored, never asked again). The list is skippable and undefined tokens pass through unchanged.
- Subject glossary: built once from the guía docente (Schwartz-Hearst abbreviation extraction, anatomic filtering, suffix and low-frequency word filtering, deduplicated) and stored per subject. Its only use is as the fallback transcription prompt for a chunk that has no notes in its time range.
- Guía docente upload: an optional PDF drop zone shown after the name when creating a subject on Sources, and again in a subject settings page for adding or replacing it. A subject without a glossary works normally: chunks with no notes in range get an empty prompt, and Sources shows a non-blocking hint. Replacing rebuilds the glossary from scratch and does not redo existing transcripts. A PDF with no extractable text is rejected and the previous glossary stays.
- Mini glossary: per chunk, from the notes whose timestamps fall in the chunk's range, with the same filters, capped at 224 tokens (Groq's documented prompt limit).

## Transcription

- Model: `whisper-large-v3` on Groq (about $0.111/hour, so about $0.22 for 2 hours; turbo is $0.04/hour but a higher word error rate). A one-line setting.
- ffmpeg cuts each audio file into chunks of about 2 minutes at natural pauses (an initial setting to test; use speech detection if classroom noise defeats silence detection). Chunk ids: `A01-C005`. Code splits chunks into sentences, numbered across the whole recording (`A01-T0042`).
- Failure and resume: ffmpeg cuts the whole file once and the chunk files are kept on disk; a chunking failure rejects the upload with the error. Each chunk's transcript is saved as soon as it returns; 429 and 5xx are retried with backoff. If a chunk still fails, transcription pauses ("Chunk A01-C017 failed") with a Retry button that re-sends only missing chunks, and reopening the app resumes the same way. There is no skip: the stage cannot complete with a gap. Changing the transcription model or a recording start time requires a full re-run, with a warning that it discards the transcript and any corrections.
- Request `verbose_json` for per-segment `avg_logprob`, `no_speech_prob`, `compression_ratio`. Each sentence inherits the worst metric of the Whisper segment(s) it overlaps. Word-level timestamps carry no confidence on Groq.
- Right after transcription, a sentence cut by a chunk boundary is stitched: if a chunk's last sentence has no terminal punctuation and the next chunk's first sentence starts lowercase, they become one sentence keeping the earlier ID and start time (the later ID is retired, never reused); metrics take the worse of the two, and playback covers both. Stitching runs before the filler regex and flagging.
- Deterministic regex removes classroom filler ("¿ya lo tenéis?", "¿ya está copiado?").
- Flagged sentence: Whisper default gates (`avg_logprob` < -1.0, `no_speech_prob` > 0.6, `compression_ratio` > 2.4) plus a medical-looking term missing from the mini glossary and abbreviation dictionary. Thresholds are tuned later on real lectures.
- Pre-merge correction pass: only flagged sentences, each with one-click playback (a few seconds of surrounding audio) and manual correction. Skippable. A skipped flag still enters the merge, and anything resting only on it is shown as low confidence.
- Low confidence: an addition or conflict is low confidence when every transcript sentence it cites is flagged and unhandled (not corrected, not advanced with `Enter`) and it cites no slide bullet. It gets a "check by ear" badge on the block and the dock entry; default state is unchanged (additions stay keep) and the badge clears once the student plays it and keeps or reverts it. It never blocks export.
- Known limit: these metrics are weak hallucination detectors and miss confident mishearings (e.g. hipertensión vs hipotensión). The safety net is playback in the final review.

## Merge

- Pool per window: slide bullets and/or transcript sentences. Windows are processed in parallel.
- Jev (TypeSafe System 1 model: typed decisions with calibrated probabilities, no explanations or free text) runs two checks:
  - Coverage: one pool item against the retrieved notes, returning covered / partially covered / missing / noise.
  - Conflict: one note block (question carries the note id) against the pool, returning supported / unsupported / conflicts. Only conflicts are flagged.
- Jev contract (TypeSafe hosted API, `POST /v1/systemone`, bearer key from local config, pinned to `jev-1.14.0` until evaluated on Spanish lecture material): a request has a shared `state` and a map of typed `choice` questions, each with instructions and a criteria map defining its labels; each question is answered independently against the shared state. Each answer returns the chosen label, a probability per label, and a separate `confidence` (concentration of the distribution, not the chance of being right; never used as such). No explanations or citations, so NoteMerge keeps its own IDs. Limits: 64k tokens for state plus all questions, 32k for state plus any single question; rate limits are per organization.
  - Coverage request per window: state = the retrieved notes (window plus margin, abbreviation-expanded); one question per in-window source item; labels `covered`, `partially_covered`, `missing`, `noise`; keys like `coverage:A01-T0042`.
  - Conflict request per window: state = the retrieved pool (window plus margin); one question per in-window note block; labels `supported`, `unsupported`, `conflicts`; keys like `conflict:N0012`. Each question includes the target text and ID.
  - Noise is accepted only when it is the chosen label and its probability is at least 0.95 (configurable, validated on real lectures); otherwise the verdict becomes `missing`.
  - Windows run with bounded configurable concurrency; 429 and 529 are retried with backoff honoring `Retry-After`. An exhausted retry or an invalid response is an explicit failure, never silently a verdict.
  - Failure handling: verdicts are saved per window as each finishes. If any window still fails after automatic retries, the merge pauses ("Jev failed on windows 12, 13") before Haiku runs; a Retry button re-runs only the failed windows, and reopening the app resumes the same way. Haiku runs only when every window has verdicts. There is no skip: a window cannot proceed unchecked. "No rerun" applies only after review begins.
- Because Jev gives no explanation, the edit list carries ids, and Haiku receives the source item text (by id) plus the relevant notes and works out what is missing or conflicting.
- Definitions:
  - Covered: the notes contain the same fact (paraphrase counts, anywhere in the retrieved range).
  - Partially covered: topic present but a specific fact (name, number, cause, relationship) is absent.
  - Missing: the fact appears nowhere in the retrieved notes.
  - Noise: no examinable subject content (class logistics, off-topic chatter, transitional phrases). Exam hints, emphasis, clinical examples and mnemonics are never noise; repeats are not noise. Labeled noise only above a high confidence threshold; uncertain items are treated as missing.
- No source outranks another. Every conflict cites each source's evidence by id and the student decides. When slide and transcript disagree with each other, the flag cites both and the proposed rewrite follows the transcript, stated as such.
- Haiku: one call for the whole lecture's edit list plus the sealed notes (expected input about 20-35k tokens; split into two calls at a window boundary only if over 100k). It places additions and proposes conflict rewrites; every part keeps its source ids.
- Haiku contract: strict structured output validated by code.
  - Input: sealed notes as ordered blocks with IDs; window time ranges; the edit list. Missing entry = source item ID, text, window. Partial entry = the same plus the IDs of the retrieved note blocks. Conflict entry = note block ID and text plus the pool items (IDs and texts, labelled slide or transcript).
  - Output: a list of operations, each carrying source IDs: `add_after(block_id, text, source_ids)`, `add_at_window(window_id, text, source_ids)`, `rewrite(block_id, text, source_ids)`. Every edit-list entry is answered by exactly one operation.
  - Validation: unknown block, window or source IDs, a source ID outside the edit list, or an entry answered zero or several times is an error. An invalid operation is dropped and logged, with no retry. A dropped entry still reaches the student as an addition or conflict flag anchored at its window's position, showing the source text verbatim (no model wording), so nothing is lost and it is clear no model placed it.
- Placement: the merged note keeps the student's block order. An addition is a new block next to a related block anywhere in the window plus margin, or, if none exists, a new block at the window's position in time. A partial fix is a new block right after the block it completes. Existing blocks are never edited; the only change to one is a conflict rewrite, held as a proposal until the student resolves it (see Conflict representation).
- Accepted trade-offs: duplicate additions are allowed (the student removes them in review); there is no completeness check on Haiku's output and no retry.
- No rerun after the student finishes.

## Review and output

- Merged note is separate from the sealed notes. Additions are green blocks, default keep; hover shows the source citation and a revert option. Conflicts are yellow blocks with no default; hover shows the sources and proposed rewrite, with "keep as is" (`K`) or "edit" (`E`, use the proposed rewrite).
- Conflict representation: the flagged block stores both versions. Unresolved, it shows the student's original text in yellow; the proposed rewrite is in the hover widget and the dock, and the text is never silently replaced. `K` keeps the original and resolves; `E` replaces the block's text with the rewrite and resolves, after which it is ordinary editable text (tweaking is normal editing, there is no separate edit mode). A resolved conflict can be reopened from the dock until export. Export takes only the block's current text. One flag per note block: the Jev conflict check is per block, so all conflicting sources for a block are cited on a single flag with a single rewrite.
- Review decisions are saved so the student can resume later.
- Export is blocked until every conflict flag is resolved.
- Playback only for material from a transcript sentence (transcript-derived additions and conflicts that cite one). Student note blocks and slide bullets get no playback. No play control when the lecture has no audio.
- Final note: clean, with no review highlights and no citations. Exported to Notion (one-way push to a new page via the student's own OAuth connection; the hover widgets cannot exist there) or to PDF.
- Notion: a public Notion integration registered once by the developer; OAuth redirects to `localhost` on the app's port and the token is stored in local config. The student shares their root page (e.g. `uni`) on the consent screen, which grants access to its children. Each subject stores a Notion parent page: the first export from a subject opens a page picker (search pre-filled with the subject name, exact title match pre-selected, or "Create a page named <subject> under <root>"), then it is remembered and editable in subject settings. Each export creates a new child page of the subject's page (so the structure is root / subject / lesson), titled with the lecture date (with a counter for several sessions in a day); exporting twice makes two pages and the lecture records the last URL. A missing or unshared stored page reports the error and reopens the picker. BlockNote blocks map one-to-one to Notion blocks (paragraphs, headings, bulleted and numbered lists, nested children), with unsupported types falling back to paragraphs; slide markers are not exported. A failed push leaves the final note unchanged and allows retry or PDF.
- PDF: rendered by the browser's print engine from the clean preview via a "Save as PDF" button and a print stylesheet; title is "Subject: lecture date".

## Language

- UI in English, strings centralised so a Spanish UI can be added later. Whisper is called with `language: es` and a Spanish mini glossary prompt; Catalan and code-switching are out of scope. Jev instructions and criteria are in English with Spanish state and targets. Haiku's system prompt is in English; all added and rewritten note text is Spanish, matching the student's terse register and using the student's abbreviations where the dictionary shows them.

## Left to tune on real lectures

- Flag thresholds and the confidence cutoff for noise.
- Chunk length (about 2 minutes is a starting point).

## UI (settled by prototype)

Reference: `prototype/notemerge-prototype.html?variant=D` (throwaway, in-memory; variants A-C are the rejected alternatives). Goal was the simplest UI with the fewest clicks.

- Before the merge, one task per full screen, keyboard first: Write, then Sources (subject defaults to the last one used, first audio start time guessed from the first slide marker, files can be dropped anywhere, mapping fixer and start-time alignment open only on demand), then Check transcript (one flagged sentence at a time: `Space` plays, `Enter` moves on; the merge starts by itself if every flag has been handled).
- Review and export: the merged note on the left, a permanent dock on the right. The dock lists conflicts (resolved inline, `K` keep mine, `E` use rewrite) and additions (Revert). The hover widgets on the note stay as specified above. Notion and PDF are two direct buttons, unlocked when every conflict is resolved, with a clean-preview toggle.
- Not prototyped: a window mapped to a range of slides, and the real BlockNote editor.
