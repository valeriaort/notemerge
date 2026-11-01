# 0001: An alignment stage so notes without timestamps can be merged

Status: accepted (2026-11-01)

## Context

The merge joins notes, slides and transcript on time. A note block's first-edit time places it in a window bounded by `//` slide markers, and Whisper timestamps place transcript sentences in the same windows. The same join drives four places in code: `computeWindows` / `assignBlockIds` (window membership), `processWindow` in `mergeLecture.ts` (pool and context margin), Haiku placement (`findWindowForBlock`), and `buildChunkPrompt` (the mini glossary for each chunk).

Students also have notes that were not typed live in NoteMerge: notes written elsewhere (e.g. in Notion) and exported, and notes from a previous year handed down by a classmate. These have no first-edit times and no slide markers, so none of the four time-based steps works for them. Everything downstream of window membership (verdicts, edit list, Haiku operations, review, export) never reads time; it only needs to know which slides, sentences and note blocks belong to which window.

## Decision

1. **Two lecture modes, chosen at creation.** A lecture has exactly one notes document: **live notes** (the editor, with timestamps and slide markers) or **untimed notes** (uploaded PDF with a text layer, Markdown or DOCX; scanned PDFs are rejected; OCR stays out of scope). Untimed notes replace the live notes as the sealed notes; they are not a reference source. Notes with neither presentation nor audio are rejected in both modes.

2. **An explicit Aligned stage.** It runs after Transcript-checked and before Merged, and persists the lecture's windows. Each window lists its slide IDs, the sentence IDs and note block IDs judged in it, and the context IDs (from neighbouring windows). The merge, Haiku placement and review read these IDs and never filter by time. The pipeline becomes Sealed → Transcribed → Transcript-checked → Aligned → Merged → Reviewed → Exported.

3. **Two producers of the same window shape.**
   - **Time alignment** (live notes) wraps today's `computeWindows` and the 1-minute context margin and must produce identical windows, so the existing tests are the regression guard.
   - **Content alignment** (untimed notes) embeds slides, transcript spans of about 30 seconds, and note blocks (with their heading path) and runs an order-preserving alignment that allows skips on both sides:
     - presentation + audio: transcript spans to slides, which places the slides on the audio timeline, then note blocks to those windows;
     - audio only: windows of about 4 minutes cut at sentence boundaries, then note blocks to those windows;
     - presentation only: one window per slide, then note blocks to slides.
     Context is the neighbouring window on each side.

4. **Embeddings come from a local `bge-m3`** behind an `EmbeddingProvider` interface, with a fake for tests. The step is local and deterministic, needs no retry/pause machinery, and is cheap to re-run. A hosted API stays a config swap if evaluation shows a need.

5. **Weak matches.** A block's alignment score is its highest similarity to any item in its assigned window; headings and very short items follow their neighbours and are never weak on their own score. A block below the threshold is a weak match. It is conflict-checked against the pool of its three most similar windows, ignoring order. A conflict gives a normal yellow flag; otherwise the block is shown gray in review with keep (rendered italic) or delete, defaulting to keep and never blocking export, and the italic is carried into the Notion and PDF export. Weak matches still count as coverage context for neighbouring windows.

6. **Threshold calibration.** The weak-match threshold is configuration, set from 2–3 lectures aligned by hand (each block labelled with its correct window or "not taught") as the lowest value at which about 95% of placed blocks land in the correct window. Precision on placed blocks is preferred because a misplaced block silently causes false conflicts and false "covered" verdicts, while a false weak match only costs one visible click. The mapping fixer (on demand from Sources; blocks and windows in two keyboard-first columns) lets the student place a block by hand, which makes it a normal placed block; its corrections double as labelled data.

7. **Transcription for untimed notes.** There is no per-chunk mini glossary before alignment, so:
   1. pass 1 prompts every chunk with one lecture glossary taken from the slides and notes (rare terms first, 224-token cap);
   2. a provisional alignment (not persisted or shown) gives each window its own glossary;
   3. pass 2 re-transcribes only flagged chunks, once, with their window's glossary;
   4. the student checks the transcript as today;
   5. the final alignment runs on the corrected transcript, because re-transcription changes sentence IDs and corrections change the text that drives matching.
   Untimed-notes lectures skip the recording start time step; audio-relative time is enough when there is no note clock.

8. **Uploaded notes are treated like the student's own.** Unknown tokens are surfaced into the one user-level abbreviation dictionary, and Haiku writes in the register of the sealed notes.

## Alternatives considered

- **Drop the live editor and align everything by content.** Rejected for now: the time path is deterministic, built and tested. Revisit, or use timestamps as a hint inside content alignment, once content alignment is measured on real lectures.
- **Hosted embeddings (OpenAI, Voyage, Cohere).** Cost is negligible (well under $0.01 per lecture, single-digit dollars per year at 600 lectures). Rejected because no benchmark shows them better on Spanish medical text, while `bge-m3` scores 0.836 nDCG@10 on the Spanish slice of MMed-Bench-IR (arXiv 2606.24200), and a hosted API adds a key, a failure mode and retry/pause handling.
- **Lexical similarity (BM25) instead of embeddings.** Rejected: 0.082 vs 0.836 on the same Spanish medical slice, and the benchmark found that adding BM25 to `bge-m3` hurt concept discrimination.
- **Forcing weak matches into their best window, or blocking the merge until the student places them.** Rejected: notes from a previous year routinely contain content that was not taught this year, so forcing creates confident false conflicts and blocking makes the merge a chore.
- **A second, reference notes document per lecture** (last year's notes as a third source beside slides and transcript, citable by ID). Deferred, not rejected: it fits "no source outranks another", but this round keeps one sealed notes document.
- **Whole-lecture pool for weak-match conflict checks.** Rejected: a 2-hour transcript can exceed Jev's 32k-token limit for state plus one question.

## Consequences

- The merge no longer depends on how windows were built, so the time-based path and the content path share every stage after alignment.
- The refactor lands first and changes no behaviour: introduce the persisted window list and time alignment, and switch `processWindow`, Haiku placement and `buildChunkPrompt` to read it with all existing tests green. Then, in order: converting PDF, Markdown and DOCX into note blocks; `EmbeddingProvider` with `bge-m3` and a fake; content alignment, weak-match scoring and the three-most-similar-windows pool; two-pass transcription; the UI (lecture mode, mapping fixer by block, gray review state, italic export).
- Review gains a third highlight (gray), and the final note is no longer free of all formatting from review: kept weak matches are italic.
- First run downloads the `bge-m3` model (about 0.5 GB).
- A new threshold (weak match) joins the configuration to tune on real lectures, and alignment accuracy needs its own evaluation with hand-aligned lectures.
