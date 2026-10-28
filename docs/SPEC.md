# NoteMerge: Spec

Status: ready for tickets. Vocabulary follows `CONTEXT.md`; behaviour and rationale follow `docs/DESIGN.md`. UI reference: variant D of the prototype.

## Problem Statement

A medical student takes live notes in class, typing fast, abbreviating heavily, and writing with a delay. Notes routinely miss facts the teacher said or showed on a slide, and occasionally record something wrong. Reconciling the notes against the slide deck and the lecture audio afterwards means replaying two hours of audio and flipping through 60+ slides by hand. It is slow, so it mostly doesn't happen, and the student studies from incomplete or incorrect notes.

## Solution

NoteMerge is a local app where the student writes notes during class in a Notion-style editor, marking each slide change with `//`. After class they upload the presentation and/or audio, pick the subject, and confirm a few details. NoteMerge transcribes the audio, lines up notes, slides and transcript by time, and checks each slide window for facts the notes miss or contradict.

The result is a separate merged note: the student's own notes, untouched, plus green suggested additions and yellow conflict flags, each citing the slide bullet or transcript sentence it came from. The student resolves every conflict (`K` keep mine, `E` use the rewrite), reverts any additions they don't want, replays the audio behind any transcript-derived suggestion, and exports a clean final note to Notion or PDF.

## User Stories

### Writing notes
1. As a student, I want to write notes in a Notion-like block editor, so that capturing a lecture feels familiar and fast.
2. As a student, I want every note block's first-edit time and last-edit time recorded against the Madrid wall clock, so that the app knows when I wrote each thing without my doing anything.
3. As a student, I want to type `//` at each slide transition and have it saved as a timestamped slide marker, so that my notes can later be mapped to the slides.
4. As a student, I want the slide marker to cost me one keystroke pair and no mouse, so that I never fall behind the teacher.
5. As a student, I want my notes to be saved continuously, so that a crash or closed tab during class loses nothing.
6. As a student, I want to start writing notes before I decide which subject they belong to, so that I'm not choosing a subject at the start of class.
7. As a student, I want to use my own abbreviations freely while writing, so that I don't slow down for the tool.
8. As a student, I want each note block to have a stable unique ID, so that every later flag and citation points at exactly one block.

### Uploading sources
9. As a student, I want to finish my notes and move to a Sources screen in one step, so that moving from class to merge is quick.
10. As a student, I want the subject to default to the last one I used, so that the common case needs no clicks.
11. As a student, I want to pick the subject from a dropdown, so that the lecture is filed under the right course.
12. As a student, I want a "+ new subject" option that lets me name a subject inline, so that I can set up a new course without leaving the flow.
13. As a student, I want to upload a subject's guía docente when I create or edit a subject, so that the subject gets a glossary of its terminology.
14. As a student, I want the guía docente turned into a small, deduplicated, static glossary (abbreviation extraction, anatomic filtering, suffix and low-frequency filtering), so that transcription has a fallback vocabulary for the subject.
15. As a student, I want to drop files anywhere on the Sources screen, so that I don't hunt for upload targets.
16. As a student, I want the app to accept notes + presentation, notes + presentation + audio, or notes + audio, so that I can merge with whatever I have.
17. As a student, I want a lecture with notes alone to be rejected with a clear message, so that I don't start a merge that cannot work.
18. As a student, I want presentation PDFs of 60+ pages to be accepted and their text extracted, ignoring images, so that large decks work.
19. As a student, I want every slide numbered (`S013`) and every bullet on it numbered (`S013-B02`), so that citations are exact.
20. As a student, I want to attach up to two audio files totalling about two hours, so that a lecture split by a break is handled.
21. As a student, I want to enter the recording start time for each audio file, so that transcript times match my notes' clock.
22. As a student, I want the first audio file's start time guessed from my first slide marker, so that I usually only need to confirm it.
23. As a student, I want a second audio file treated as a continuation after a break with its own start time, so that the gap isn't assumed away.
24. As a student, I want to align one recognizable audio moment with a slide marker when I don't know the start time, so that the app derives the start time (e.g. audio 04:20 = marker 09:14:20 gives about 09:10:00).
25. As a student, I want the start-time alignment tool to appear only when I ask for it, so that the normal path stays uncluttered.
26. As a student, I want windows mapped to slides sequentially by default (window n = slide n), so that the usual case needs no setup.
27. As a student, I want to reassign, merge, or delete windows by hand when the mapping is wrong, so that a skipped or revisited slide doesn't corrupt the merge.
28. As a student, I want a slide to be able to span several windows and a window several slides, so that real classroom behaviour is representable.
29. As a student, I want the mapping fixer to open only on demand, so that it doesn't distract when the mapping is right.
30. As a student, I want unknown short tokens in my notes surfaced at upload for me to define, so that abbreviations I haven't recorded yet get added to my dictionary.
31. As a student, I want a personal abbreviation dictionary (`pc → paciente`) that persists across lectures and subjects, so that I define each abbreviation once.
32. As a student, I want abbreviation matching on whole words with case rules, so that `pc` inside a longer word is never expanded.
33. As a student, I want my abbreviations expanded only in copies sent to transcription and the merge, so that my own note blocks are never rewritten.
34. As a student, I want my notes sealed (read-only) once I upload, so that the merge has a fixed source and later edits cannot desync it.

### Windows and pooling
35. As a student, I want windows to run marker to marker with no gaps, so that every moment of the lecture belongs to a window.
36. As a student, I want an empty window (nothing written) to still be a window, so that I get flagged on slides I wrote nothing for.
37. As a student, I want each note block placed in the window containing its first-edit time, so that late edits don't move it.
38. As a student, I want notes and transcript also retrieved from 1 minute either side of a window as context only, so that writing delay doesn't create false "missing" verdicts.
39. As a student, I want only items inside a window judged, so that each item is flagged at most once.
40. As a student, I want typed markers to still bound windows (labeled by number) when I upload no presentation, so that audio-only lectures still get structured.
41. As a student, I want fixed 4-minute windows used only when there are no markers at all, so that markerless lectures still merge.

### Transcription
42. As a student, I want audio cut into chunks of about 2 minutes at natural pauses, so that each piece suits the transcription service.
43. As a student, I want chunk and sentence IDs (`A01-C005`, `A01-T0042`) numbered across the whole recording, so that every transcript sentence is uniquely citable.
44. As a student, I want each chunk's transcription prompted with a mini glossary built from the notes I wrote during that chunk's time range, so that my own vocabulary is recognized.
45. As a student, I want the subject glossary used as the prompt for chunks where I wrote nothing, so that quiet stretches still get domain vocabulary.
46. As a student, I want the prompt capped at the provider's documented token limit, so that requests never fail on prompt length.
47. As a student, I want classroom filler ("¿ya lo tenéis?", "¿ya está copiado?") removed deterministically, so that it never reaches the merge.
48. As a student, I want the transcription model to be a one-line setting, so that I can trade cost for accuracy later.
49. As a student, I want sentences possibly misheard flagged using the provider's quality metadata and a medical-term check, so that I only review the doubtful ones.
50. As a student, I want a pre-merge pass showing only flagged sentences one at a time, so that correction is quick and focused.
51. As a student, I want `Space` to play a flagged sentence with a few seconds of surrounding audio, so that I can judge it by ear.
52. As a student, I want `Enter` to move on from a flagged sentence, so that I can clear the queue from the keyboard.
53. As a student, I want to correct a flagged sentence's text manually, so that a mishearing doesn't poison the merge.
54. As a student, I want the whole check skippable, so that I can merge immediately when I'm short on time.
55. As a student, I want the merge to start by itself when every flag has been handled, so that I don't click "start".
56. As a student, I want a skipped flag to still enter the merge, with anything resting only on it shown as low confidence, so that skipping is safe but visible.

### Merge
57. As a student, I want each slide bullet and transcript sentence in a window checked against my notes as covered, partially covered, missing, or noise, so that gaps are found item by item.
58. As a student, I want a paraphrase, or a fact written late within the context margin, to count as covered, so that I'm not told to add what I already have.
59. As a student, I want "partially covered" used only when a specific fact (name, number, cause, relationship) is absent, so that I'm not nagged about trivia.
60. As a student, I want logistics, off-topic chatter and transitions treated as noise only when the model is highly confident, so that real content is never dropped.
61. As a student, I want exam hints, emphasis, clinical examples, mnemonics and repeated facts never treated as noise, so that the things teachers stress are not lost.
62. As a student, I want every note block checked against the window's slides and transcript as supported, unsupported, or conflicts, so that mistakes in my notes are found.
63. As a student, I want only conflicts flagged, so that notes the sources don't mention are left alone.
64. As a student, I want no source to outrank another, with each conflict citing evidence from each source by ID, so that I make the call.
65. As a student, I want, when slide and transcript disagree with each other, the flag to cite both and propose a rewrite following the transcript (stated as such), so that I see the discrepancy and the likely truth.
66. As a student, I want windows processed in parallel, so that the merge finishes quickly.
67. As a student, I want one writing pass over the whole lecture's edit list and sealed notes, so that additions are placed coherently.
68. As a student, I want the merged note to keep my block order, so that it still reads like my notes.
69. As a student, I want an addition placed as a new block beside a related block anywhere in its window plus margin, or at the window's position in time if none exists, so that additions land where I'd expect.
70. As a student, I want a partial fix added as a new block right after the block it completes, so that the correction reads in context.
71. As a student, I want my existing blocks never edited except by conflict rewrites shown in place as proposals, so that I can trust nothing was changed silently.
72. As a student, I want the merge to run once per lecture, so that results are stable once I begin reviewing.

### Review
73. As a student, I want the merged note on the left and a permanent dock on the right, so that all decisions are visible and one click away.
74. As a student, I want the dock to list conflicts with `K` keep mine and `E` use rewrite, so that I can resolve them from the keyboard.
75. As a student, I want the dock to list additions, each with Revert, so that I can drop unwanted suggestions.
76. As a student, I want additions shown as green blocks, default keep, so that accepting is free.
77. As a student, I want conflicts shown as yellow blocks with no default, so that I must decide each.
78. As a student, I want hovering a block to show its citation (and, for conflicts, the proposed rewrite) with the same actions, so that I can decide in context.
79. As a student, I want citations to name the slide bullet or transcript sentence by ID with its text, so that I can verify the source.
80. As a student, I want playback for any addition or conflict resting on a transcript sentence, so that I can hear what the teacher said.
81. As a student, I want no playback control for slide bullets, my own blocks, or lectures without audio, so that the UI doesn't offer what doesn't exist.
82. As a student, I want low-confidence items (resting on a skipped flagged sentence) clearly marked, so that I check them by ear first.
83. As a student, I want duplicate additions tolerated and easy to revert, so that review never blocks on the merge being perfect.
84. As a student, I want my review decisions saved continuously, so that I can close the app and resume later.

### Export
85. As a student, I want export disabled until every conflict is resolved, so that I never export unresolved contradictions.
86. As a student, I want additions kept by default so that I only act on the ones I reject.
87. As a student, I want a clean-preview toggle showing the final note without highlights or citations, so that I can see exactly what I'll export.
88. As a student, I want two direct buttons, Notion and PDF, so that exporting is one click.
89. As a student, I want Notion export to push a new page through my own OAuth connection, so that my notes land in my workspace without sharing credentials with the app.
90. As a student, I want the exported note to be plain editable content with no highlights or citations, so that it is a normal note afterwards.

### Library and operations
91. As a student, I want every lecture's notes, presentation, audio, transcript, merged note and final note kept per lecture with no automatic deletion, so that I can return to any of them.
92. As a student, I want to reopen a lecture at whatever stage it reached (writing, sources, transcript check, review, exported), so that I never lose progress.
93. As a student, I want my API keys held in a local config, so that the app runs on my machine without any account.
94. As the developer, I want a user concept in the data model even though the app is single-user, so that accounts can be added later without a rewrite.
95. As a student, I want clear errors when a transcription or merge call fails, so that I know what happened and what to do.
96. As a student, I want a failed transcription or merge to pause with a Retry button that re-runs only what failed, so that I never pay twice or lose finished work.
97. As a student, I want reopening the app mid-transcription or mid-merge to resume where it stopped, so that closing the laptop is safe.
98. As a student, I want a notice on Sources when the number of windows and slides differ (e.g. "12 windows, 14 slides"), so that I know to check the mapping.
99. As a student, I want the guía docente upload to be optional and replaceable from subject settings, so that a missing glossary never blocks me.
100. As a student, I want each subject's exports to land as new lesson pages under that subject's page in my Notion (root / subject / lesson), so that my existing Notion structure stays intact.
101. As a student, I want the subject's Notion page chosen once with a search pre-filled with the subject name, so that later exports need no setup.
102. As a student, I want a "check by ear" badge on suggestions resting only on unreviewed flagged sentences, so that I know which ones to listen to first.
103. As a student, I want a resolved conflict reopenable from the dock until export, so that I can change my mind.
104. As a student, I want a warning before changing the transcription model or a recording start time discards my transcript and corrections, so that I never lose work by accident.

## Implementation Decisions

### Architecture
- Local web application, TypeScript end to end: a React front end with BlockNote (notes and merged note) and a local Node HTTP server that also serves it. SQLite for structured data; the file system for audio, chunks and PDFs, one folder per lecture. ffmpeg runs as a child process; a Node PDF library that exposes font sizes and positions extracts slide text; Schwartz-Hearst is reimplemented in TypeScript and checked against its public reference implementation. Single user; secrets in a local config file. The data model carries a user entity (owner of the abbreviation dictionary) but there is no authentication.
- Language: UI in English with strings centralised for a later Spanish UI. Whisper is called with Spanish as the language. Jev instructions and criteria are English over Spanish text. Haiku's prompt is English and all added or rewritten note text is Spanish, in the student's terse register and using the student's abbreviations where the dictionary shows them. Catalan and code-switching are out of scope.
- External services behind narrow interfaces so each can be replaced by a fake: speech-to-text (Groq `whisper-large-v3`), coverage/conflict classifier (Jev), writing model (Haiku), Notion. ffmpeg is used locally for chunking.
- Processing is a staged pipeline per lecture: Sealed → Transcribed → Transcript-checked → Merged → Reviewed → Exported. Each stage persists its output so the app can resume and each stage can be inspected.

### Domain model
- Subject: name, subject glossary (list of terms), Notion parent page, owner user. Lecture: created when the student starts writing, with no subject yet; the subject is set at upload. It holds the notes document, an optional presentation, up to two audio files, and all derived artifacts. Valid uploads are notes + presentation, notes + presentation + audio, and notes + audio; notes alone are rejected, and a presentation without notes is not offered. Notes are sealed (read-only) at upload.
- Note block: one editor block (paragraph, heading, or list item; nested children are separate blocks). Stable ID stored in the document and never recomputed; first-edit time (first keystroke that gave it content; an empty block has none); last-edit time (stored, never used for placement). Split: the first half keeps the ID and times, the second half is new with first-edit time = split time. Merge: the upper block's ID and first-edit time survive, the lower ID is retired. Paste: new IDs, first-edit time = paste time. Move: ID and first-edit time unchanged, so a move never changes the window.
- Slide marker: timestamped event in the notes stream meaning "the next slide starts now"; the first `//` is the transition from slide 1 to slide 2.
- Presentation: slides `S###`, bullets `S###-B##`, text only. Bullets are extracted deterministically: text per page in reading order; lines repeating on more than about half the pages and bare page numbers dropped; the largest-font top line stored as the slide title, not a bullet; a bullet glyph or number starts a new bullet, other lines join the previous one while it lacks terminal punctuation; nesting flattened. A slide with no text has no bullets and is judged from the transcript only. A PDF with no extractable text on most pages is rejected as scanned images; OCR is out of scope.
- Audio: `A##`, chunks `A##-C###`, sentences `A##-T####` numbered across the whole recording, each with quality metrics (worst of the overlapped Whisper segments' `avg_logprob`, `no_speech_prob`, `compression_ratio`) and a flag state.
- Slide window: time range, ordered list of mapped slides (possibly many-to-many with slides), the pool (bullets and sentences in-window), the notes (in-window and margin), and the margin context.
- Edit list entry: verdict type (missing / partial / conflict), the source ID(s), the note ID (for conflicts), window. Merged note blocks carry provenance (addition / partial fix / conflict rewrite), source citations, and a review state.
- Abbreviation dictionary: user-level pairs, whole-word, case-aware.

### Time model
- Wall-clock time in Europe/Madrid for all note events. Recording start time is entered per audio file; chunk clock time = recording start + elapsed audio time. File creation time is never used.
- Lecture start = earliest of the first note block's first-edit time and the first audio file's recording start time; lecture end = latest of the last note edit and the last audio file's end. N markers give N+1 windows: window 1 starts at lecture start, window n runs from marker n-1 to marker n, the last ends at lecture end. A marker typed right at lecture start yields an empty window 1, which is dropped.
- A transcript sentence belongs to the window containing its start time (from Whisper segment timestamps within its chunk). The context margin is a configurable constant, default 1 minute.
- Without a presentation, typed markers still bound windows, labeled by number only. Fixed 4-minute windows are used only when there are no markers at all. Windows map to slides sequentially by default (window n = slide n) and can be reassigned, merged or deleted by hand.
- The first start time is pre-filled from the first slide marker. An alignment anchor (audio time ↔ marker time) derives the start time on demand.

### Transcription
- ffmpeg cuts at natural pauses, target 2 minutes, with speech detection as the documented fallback if silence detection fails in noisy rooms. Requests use `verbose_json`.
- Each chunk's prompt is its mini glossary (terms from notes in the chunk's time range, filtered, abbreviation-expanded, capped at 224 tokens), or the subject glossary when the range has no notes.
- Code splits chunks into sentences, then stitches a sentence cut by a chunk boundary (last sentence lacks terminal punctuation and the next chunk's first sentence starts lowercase): the joined sentence keeps the earlier ID and start time, the later ID is retired and never reused, metrics take the worse value, and playback covers both. Stitching runs before the filler regex and flagging.
- Failure and resume: ffmpeg cuts the whole file once and keeps the chunk files; a chunking failure rejects the upload. Each chunk's transcript is saved as it returns; 429 and 5xx are retried with backoff. A chunk that still fails pauses transcription with a Retry button that re-sends only missing chunks; reopening the app resumes the same way. There is no skip, so the stage cannot complete with a gap. Changing the transcription model or a start time requires a full re-run, with a warning.
- Abbreviation matching: whole tokens split on whitespace and punctuation; case-insensitive by default with an optional per-pair "match case exactly" flag; the expansion follows the matched token's capitalisation; multi-token abbreviations match longest first. At upload, unknown tokens are listed when absent from the dictionary and subject glossary, not an ordinary Spanish word (bundled list), and at most 5 characters or all-caps; ranked by frequency, with define, ignore, or ignore permanently. The list is skippable; undefined tokens pass through unchanged.
- Guía docente: optional PDF when creating a subject and in subject settings; replacing rebuilds the glossary without redoing transcripts; a PDF with no extractable text is rejected and the previous glossary stays. A subject without a glossary gets an empty prompt for chunks with no notes in range, plus a non-blocking hint.
- A sentence is flagged if a metric crosses a Whisper default gate (`avg_logprob` < -1.0, `no_speech_prob` > 0.6, `compression_ratio` > 2.4) or it contains a medical-looking term absent from the mini glossary and abbreviation dictionary. Thresholds are configuration, tuned later.

### Merge
- Jev is TypeSafe's hosted System One API (bearer key from local config, model pinned to `jev-1.14.0` until evaluated on Spanish lectures). A request has a shared state plus a map of typed choice questions, each with instructions and a criteria map defining its labels; each answer returns the chosen label, a probability per label, and a separate confidence that describes the distribution and is never read as the chance of being right. There are no explanations or citations, so NoteMerge keeps its own IDs. Limits: 64k tokens for state plus all questions and 32k for state plus any one question.
- Per window, one coverage request (state = retrieved notes for the window plus margin, abbreviation-expanded; one question per in-window source item; labels covered, partially_covered, missing, noise; keys like `coverage:A01-T0042`) and one conflict request (state = the retrieved pool; one question per in-window note block carrying its ID; labels supported, unsupported, conflicts; keys like `conflict:N0012`). Only conflicts are flagged. Noise counts only when it is the chosen label with probability at least 0.95 (configurable); otherwise the verdict becomes missing.
- Windows run with bounded, configurable concurrency; 429 and 529 are retried with backoff honoring `Retry-After`. Verdicts are saved per window. A window that still fails pauses the merge before Haiku runs, with a Retry button for only the failed windows; reopening the app resumes the same way. Haiku runs only when every window has verdicts. There is no skip and a failure never becomes a verdict. "No rerun" applies only once review begins.
- Only Missing, Partially covered and Conflicts enter the edit list. Because Jev gives no explanation, Haiku receives the source item text by ID plus the relevant notes and works out what is missing or what conflicts.
- Haiku makes one call for the lecture's whole edit list plus the sealed notes (expected 20-35k tokens; split in two at a window boundary only above 100k), with strict structured output. Input: sealed notes as ordered blocks with IDs; window time ranges; edit-list entries (missing: source item ID, text, window; partial: the same plus the retrieved note block IDs; conflict: note block ID and text plus pool items with IDs, texts and a slide or transcript label). Output: a list of operations each carrying source IDs: add after a block, add at a window, or rewrite a block; every entry is answered by exactly one operation.
- Code validates Haiku's output. Unknown block, window or source IDs, a source ID outside the edit list, or an entry answered zero or several times is an error; an invalid operation is dropped and logged, with no retry. A dropped entry still reaches the student as an addition or conflict flag at its window's position showing the source text verbatim, so nothing is lost and it is clear no model placed it. Duplicate additions are accepted.
- Conflict flags cite each source's evidence by ID; slide vs transcript disagreements cite both and the rewrite follows the transcript.
- Verdict definitions, which are the basis of the Jev question instructions and criteria: covered = the notes contain the same fact (a paraphrase counts, anywhere in the retrieved range); partially covered = the topic is present but a specific fact (name, number, cause, relationship) is absent; missing = the fact appears nowhere in the retrieved notes; noise = no examinable subject content (class logistics, off-topic chatter, transitional phrases), and exam hints, emphasis, clinical examples, mnemonics and repeated facts are never noise.
- Placement: the merged note keeps the student's block order. An addition is a new block next to a related block anywhere in the window plus margin or, if none exists, a new block at the window's position in time. A partial fix is a new block right after the block it completes. Existing blocks are never edited; the only change to one is a conflict rewrite, held as a proposal until the student resolves it.

### Review and export UI (variant D)
- Before the merge, one task per full screen, keyboard first: Write → Sources → Check transcript. On Sources: subject default, first start time guessed, drop-anywhere uploads, mapping fixer and start-time alignment on demand. On Check transcript: one flagged sentence at a time, `Space` plays, `Enter` advances, merge auto-starts when the queue is clear.
- Review and export: merged note on the left, permanent dock on the right listing conflicts (`K` / `E`) and additions (Revert). Hover widgets on the note mirror the dock. Notion and PDF buttons unlock when every conflict is resolved; a clean-preview toggle shows the final note.
- Review state (per addition: keep/revert; per conflict: unresolved/kept/edited) persists so review is resumable.
- Conflict representation: the flagged block stores both versions. Unresolved, it shows the student's original text in yellow, with the rewrite in the hover widget and dock; text is never silently replaced. `K` keeps the original; `E` replaces the block's text with the rewrite, after which it is ordinary editable text (no separate edit mode). A resolved conflict can be reopened from the dock until export; export takes only the block's current text. There is one flag per note block, citing all conflicting sources, with one rewrite.
- Low confidence: an addition or conflict is low confidence when every transcript sentence it cites is flagged and unhandled (not corrected, not advanced) and it cites no slide bullet. It gets a "check by ear" badge; defaults are unchanged, the badge clears once the student plays it and keeps or reverts it, and it never blocks export.
- Sources screen notice when the window count and slide count differ (e.g. "12 windows, 14 slides"); nothing else changes.
- Playback is offered only for transcript-derived material and only when the lecture has audio; it plays the sentence with a few seconds of context.
- Not prototyped and therefore to be designed during build: a window mapped to a range of slides, and the real BlockNote editor with custom styling for green/yellow blocks.

### Export
- Final note is the merged note with kept additions, resolved conflicts (original or rewrite), no highlights, no citations. Notion: a public Notion integration registered once by the developer; OAuth redirects to localhost and the token is stored in local config. The student shares their root page on the consent screen, which grants access to its children. Each subject stores a Notion parent page, chosen once through a picker (search pre-filled with the subject name, exact match pre-selected, or create a page named after the subject under the root) and editable in subject settings. Each export creates a new child page of the subject's page (root / subject / lesson) titled with the lecture date, with a counter for several sessions in a day; exporting twice makes two pages. Blocks map one-to-one to Notion blocks, unsupported types fall back to paragraphs, and slide markers are not exported. A missing or unshared stored page reports the error and reopens the picker; a failed push leaves the final note unchanged and allows retry or PDF. PDF: rendered by the browser's print engine from the clean preview, titled "Subject: lecture date".

## Testing Decisions

- A good test drives the system through its external behaviour (inputs a student provides, outputs they see or export) and does not assert on internal structure, prompts, or intermediate data shapes beyond the documented IDs and verdict contracts.
- **Primary seam (confirmed): the local server's API, covering the lecture lifecycle** — create a lecture with notes (including timestamped blocks and slide markers) and optional presentation and audio, run transcription, run the merge, record review decisions, and fetch the final note and exports. Everything the student can do after typing maps to calls at this seam, so most behaviour in this spec can be verified here.
- The external providers (Groq, Jev, Haiku, Notion) are replaced with controllable fakes at their interfaces; ffmpeg and PDF text extraction run for real on small fixture files. Fakes return scripted verdicts so tests can assert, for example, that a "missing" verdict yields a green addition placed in the right window, that a conflict is flagged exactly once, that export is refused while a conflict is unresolved, and that skipped flags produce low-confidence marking.
- Behaviours to cover at the seam: window tiling and slide mapping (default, merged, reassigned, many-to-many); marker-less and presentation-less fallbacks; notes-alone rejection; margin retrieval with in-window-only judging; start-time guess and alignment derivation; second-file continuation; abbreviation expansion applied only to copies; glossary selection (mini vs subject fallback) and token cap; filler removal; flag rules; placement rules; sealed notes immutability; review persistence and resume; export gating and clean output; lecture start and end and the N+1 window rule; sentence assignment by start time and chunk-boundary stitching; note block identity under split, merge, paste and move; slide bullet extraction rules; Jev retry, per-window persistence, pause and resume (including no skip); Haiku output validation and the dropped-operation fallback; transcription pause and resume; conflict K/E/reopen behaviour; low-confidence badge rule; Notion parent-page selection and child-page creation (with a fake Notion).
- A thin end-to-end browser smoke test of the variant D flow with the same fakes is acceptable to guard keyboard shortcuts and screen sequencing, but is not a second behavioural seam.
- Prior art: none in the repository (greenfield). The prototype is throwaway and is not a test reference.

## Out of Scope

- Accounts, authentication, multi-user sharing, or hosted deployment.
- Rerunning the merge after the student finishes; any retry or completeness check on Haiku output.
- Image content in slides; OCR of slides; handwriting.
- Automatic deletion or retention policies.
- Chaining multiple audio files automatically; trusting file creation time.
- Editing sealed notes after upload (all changes happen on the merged note).
- Two-way Notion sync; export formats beyond Notion and PDF.
- Playback for slide bullets or student note blocks.
- Real-time (during-class) transcription or suggestions.
- Final tuning of flag thresholds, the noise confidence cutoff, and chunk length (tuned later on real lectures).
- Mobile layout.

## Further Notes

### Remaining open items
- Thresholds are configuration to tune on real lectures: Whisper flag gates, the noise cutoff (starting at 0.95), the conflict decision (chosen label), chunk length, and the context margin (default 1 minute). Jev's pinned version (`jev-1.14.0`) and its probabilities must be validated on Spanish lecture material before the thresholds are treated as settled.
- Not prototyped: a window mapped to a range of slides, and the real BlockNote editor with custom green and yellow blocks.
