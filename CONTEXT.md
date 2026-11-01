# NoteMerge

Merges a student's class notes, live or uploaded, with the lecture's slides and audio transcript, flagging what the notes miss or contradict so the student can review each suggestion.

## Language

**Subject**:
A course the student takes. Owns a subject glossary (built from its guía docente) and many lectures.

**Lecture**:
One class session: exactly one notes document (live notes or untimed notes, chosen when the lecture is created and assigned to a subject only at upload), at most one presentation, and at most one audio recording (which may span several files), producing one merge, one merged note, and one final note. Notes with neither a presentation nor audio are rejected. Everything is kept per lecture.
_Avoid_: Class, session

**Live notes**:
Notes typed in NoteMerge's editor during class, with a first-edit time on every note block and slide markers. Aligned by time.

**Untimed notes**:
Notes uploaded as a PDF with a text layer, Markdown or DOCX: written elsewhere (e.g. in Notion) or handed down from a previous year. They have no timestamps or slide markers, are aligned by content, and are otherwise treated exactly like live notes (sealed, merged, abbreviation-expanded). Scanned PDFs are rejected.
_Avoid_: Old notes, imported notes

**Chunk**:
A ~2-minute cut of an audio recording, split at natural pauses, used only as the unit of transcription (e.g. `A01-C005`).
_Avoid_: Segment

**Recording start time**:
The wall-clock time at which an audio recording began, entered by the user separately for every audio file (a second file is a continuation after a break, never chained automatically); derived from an alignment anchor only when unknown. A chunk's clock time is recording start time plus elapsed audio time. Not asked for untimed notes, where audio-relative time is enough.
_Avoid_: File creation time

**Slide marker**:
A `//` divider typed in live notes at a slide transition, saved as a timestamped event. It marks the moment the next slide starts (the first marker is the transition from slide 1 to slide 2; slide 1 has no marker of its own). It maps the notes to the uploaded presentation and bounds windows.
_Avoid_: Divider, slide-transition event

**Alignment**:
The pipeline stage that decides which slides, transcript sentences and note blocks belong to each window, and stores that as lists of IDs. Time alignment serves live notes; content alignment (local embeddings with order-preserving matching) serves untimed notes. Everything after alignment reads only these IDs.

**Window**:
One unit of comparison: the slides, transcript sentences and note blocks judged together, plus context from its neighbours. Windows tile the lecture with no gaps, and an empty window is still a window. With live notes, a window is the time range from one slide marker to the next (the first starts at the lecture start, the last ends at the lecture end; N markers give N+1 windows), and a note block belongs to the window containing its first-edit time; typed markers still bound windows when no presentation was uploaded (labeled by number only), and fixed 4-minute windows are used only when there are no markers. With untimed notes, windows follow the slides (placed on the audio timeline when there is audio), or are about 4 minutes of transcript cut at sentence boundaries when there is no presentation, and note blocks are matched to them by content. Windows map to slides sequentially by default (window n = slide n); the user can reassign, merge, or delete windows by hand, so a slide may span several windows and a window several slides.
_Avoid_: Segment, section, slide window

**Weak match**:
A note block of untimed notes whose best similarity to its window falls below the configured threshold. It is conflict-checked against its three most similar windows. With no conflict it is shown gray in review, where the student keeps it (shown italic, also in the final note) or deletes it; untouched means kept. A weak match still counts as context for coverage in neighbouring windows.
_Avoid_: Unplaced block, unmatched note

## Merge verdicts

**Coverage verdict**:
Jev's label for one source item (slide bullet or transcript sentence) against the retrieved notes: covered, partially covered, missing, or noise.
_Avoid_: Classification

**Covered**:
The notes contain the same fact as the source item. A paraphrase counts, and the notes may sit anywhere in the retrieved neighbor range, so late writing does not make an item missing.

**Partially covered**:
The notes contain the topic but lack a specific fact the source states (a name, number, cause, or relationship).

**Missing**:
The fact appears nowhere in the retrieved notes.

**Conflict verdict**:
Jev's label for one note block against the pool: supported, unsupported, or conflicts. Only conflicts are flagged.

**Noise**:
A source item with no examinable subject content: class logistics, off-topic chatter, or transitional phrases. Exam hints, emphasis, clinical examples, and mnemonics are never noise, and neither are repeats (a repeated fact is judged covered or missing like any other). Jev labels noise only above a high confidence threshold; uncertain items are treated as missing.

**Conflict**:
A note block that contradicts a source item. No source (slide, transcript) outranks another: every conflict cites the evidence from each source by ID, and the student decides. When slide and transcript disagree with each other, the flag cites both and the proposed rewrite follows the transcript, stated as such.

## Notes

**Note block**:
One unit of the notes: a single editor block (paragraph, heading, or list item); a parent and its nested children are separate note blocks. Its ID never changes. In live notes its first-edit time places it in a window and its last-edit time is stored but never used for placement; in untimed notes it is placed by content alignment.

**Sealed notes**:
The notes after upload, read-only and the fixed source for the merge. All later changes happen on the merged note.

**Merged note**:
The separate document produced by the merge: the sealed notes plus suggested additions, conflict flags and gray weak matches, reviewed and accepted by the student.

**Final note**:
The accepted merged note as exported (to Notion or PDF): plain editable content with no review highlights and no citations, except that kept weak matches stay italic. Citations and keep/revert state exist only inside NoteMerge's review. Export is blocked until every conflict flag is resolved (kept as is or edited); green additions and gray weak matches default to keep.

**Abbreviation dictionary**:
The student's personal, user-level list of `abbreviation → expansion` pairs (e.g. `pc → paciente`). Applied deterministically to copies of the notes that feed the transcription prompt, the alignment and the merge comparison; note blocks are never rewritten. Unknown short tokens are surfaced at upload for the student to define, for untimed notes too.

**Mini glossary**:
The set of subject-relevant terms used as one chunk's transcription prompt (capped at the provider's prompt-token limit). For live notes it comes from the note blocks whose timestamps fall in the chunk's time range; for untimed notes it comes from the chunk's window after a provisional alignment and is used only to re-transcribe flagged chunks.

**Lecture glossary**:
For untimed notes only: one set of rare subject terms drawn from the presentation and notes, used as every chunk's prompt in the first transcription pass.

**Subject glossary**:
A static, deduplicated list of terms extracted once from a subject's guía docente and stored with that subject. Used only as the fallback transcription prompt for a chunk of live notes that has no notes in its time range.

## Transcription

**Flagged sentence**:
A transcript sentence marked as possibly misheard from the transcription quality metadata. The student can play it back with surrounding audio and correct it in a skippable pre-merge pass; a skipped flag still enters the merge, and anything resting only on it is shown as low confidence.

**Context margin**:
The context retrieved around a window, for both the coverage check and the conflict check: notes and transcript from 1 minute on each side with live notes, and from the neighbouring window on each side with untimed notes. Only items inside the window itself are judged, so each item is flagged at most once.

## Deferred

**Reference notes** (not built): a second notes document per lecture, such as last year's notes alongside live notes, used as a third source beside slides and transcript and citable by ID. See `docs/adr/0001-alignment-stage-for-untimed-notes.md`.
