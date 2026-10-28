# NoteMerge

Merges a student's live class notes with the lecture's slides and audio transcript, flagging what the notes miss or contradict so the student can review each suggestion.

## Language

**Subject**:
A course the student takes. Owns a subject glossary (built from its guía docente) and many lectures.

**Lecture**:
One class session: exactly one notes document (assigned to a subject only at upload), at most one presentation, and at most one audio recording (which may span several files), producing one merge, one merged note, and one final note. Everything is kept per lecture.
_Avoid_: Class, session

**Chunk**:
A ~2-minute cut of an audio recording, split at natural pauses, used only as the unit of transcription (e.g. `A01-C005`).
_Avoid_: Segment

**Recording start time**:
The wall-clock time at which an audio recording began, entered by the user separately for every audio file (a second file is a continuation after a break, never chained automatically); derived from an alignment anchor only when unknown. A chunk's clock time is recording start time plus elapsed audio time.
_Avoid_: File creation time

**Slide marker**:
A `//` divider typed in the notes at a slide transition, saved as a timestamped event. It marks the moment the next slide starts (the first marker is the transition from slide 1 to slide 2; slide 1 has no marker of its own). It maps the notes to the uploaded presentation and bounds slide windows.
_Avoid_: Divider, slide-transition event

**Slide window**:
The time range from one slide marker's timestamp to the next, so windows tile the lecture with no gaps (the first window starts at the lecture start, the last ends at the lecture end; N markers give N+1 windows); defines the pool of material compared for one slide. A note block belongs to the window containing its first-edit time. When no presentation was uploaded, typed slide markers still bound the windows (labeled by number only); a 4-minute comparison window is used only when there are no markers. A lecture with notes alone is rejected at upload. Windows map to slides sequentially by default (window n = slide n); the user can reassign, merge, or delete windows by hand, so a slide may span several windows and a window several slides.
_Avoid_: Segment

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
One unit of the student's typed notes: a single editor block (paragraph, heading, or list item); a parent and its nested children are separate note blocks. Its ID never changes. Its first-edit time places it in a slide window; its last-edit time is stored but never used for placement.

**Sealed notes**:
The student's notes after upload, read-only and the fixed source for the merge. All later changes happen on the merged note.

**Merged note**:
The separate document produced by the merge: the sealed notes plus suggested additions and conflict flags, reviewed and accepted by the student.

**Final note**:
The accepted merged note as exported (to Notion or PDF): plain editable content with no review highlights and no citations. Citations and keep/revert state exist only inside NoteMerge's review. Export is blocked until every conflict flag is resolved (kept as is or edited); green additions default to keep.

**Abbreviation dictionary**:
The student's personal, user-level list of `abbreviation → expansion` pairs (e.g. `pc → paciente`). Applied deterministically to copies of the notes that feed the transcription prompt and the merge comparison; the student's own note blocks are never rewritten. Unknown short tokens are surfaced at upload for the student to define.

**Mini glossary**:
The set of subject-relevant terms taken from the note blocks whose timestamps fall in a chunk's time range, used as that chunk's transcription prompt (capped at the provider's prompt-token limit).

**Subject glossary**:
A static, deduplicated list of terms extracted once from a subject's guía docente and stored with that subject. Used only as the fallback transcription prompt for a chunk that has no notes in its time range.

## Transcription

**Flagged sentence**:
A transcript sentence marked as possibly misheard from the transcription quality metadata. The student can play it back with surrounding audio and correct it in a skippable pre-merge pass; a skipped flag still enters the merge, and anything resting only on it is shown as low confidence.

**Context margin**:
The extra time (1 minute, on each side) around a slide window from which notes and transcript are also retrieved, as context only, for both the coverage check and the conflict check. Only items inside the window itself are judged, so each item is flagged at most once.
