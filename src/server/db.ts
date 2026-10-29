import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";
import type {
  AbbreviationPair,
  AudioChunk,
  AudioFile,
  ChunkStatus,
  Citation,
  EditListEntry,
  EditListEntryType,
  Lecture,
  MergedBlock,
  MergedBlockOrigin,
  MergedBlockReviewState,
  MergeRun,
  MergeRunState,
  Operation,
  OperationKind,
  OperationStatus,
  Sentence,
  SentenceFlagState,
  SentenceStatus,
  SlideMarker,
  Subject,
  TranscriptRun,
  TranscriptRunState,
  User,
  WindowOverride,
  WindowResult,
  WindowResultStatus,
} from "../shared/types.js";

export type DbRow = {
  id: string;
  user_id: string;
  stage: string;
  subject_id: string | null;
  data_dir: string;
  notes_data: string;
  presentation_path: string | null;
  created_at: number;
  updated_at: number;
};

export type SubjectRow = {
  id: string;
  name: string;
  user_id: string;
  created_at: number;
  glossary_terms: string | null;
  guia_docente_path: string | null;
};

function rowToSubject(row: SubjectRow): Subject {
  return {
    id: row.id,
    name: row.name,
    userId: row.user_id,
    createdAt: row.created_at,
    glossaryTerms: row.glossary_terms ? (JSON.parse(row.glossary_terms) as string[]) : [],
    guiaDocente: row.guia_docente_path ?? null,
  };
}

function rowToLecture(row: DbRow): Lecture {
  return {
    id: row.id,
    userId: row.user_id,
    stage: row.stage as Lecture["stage"],
    subjectId: row.subject_id,
    dataDir: row.data_dir,
    notesData: row.notes_data,
    presentationPath: row.presentation_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openDb(dbPath: string) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lectures (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      stage TEXT NOT NULL DEFAULT 'writing',
      subject_id TEXT,
      data_dir TEXT NOT NULL,
      notes_data TEXT NOT NULL DEFAULT '{"blocks":[],"meta":{}}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slide_markers (
      id TEXT PRIMARY KEY,
      lecture_id TEXT NOT NULL REFERENCES lectures(id),
      timestamp INTEGER NOT NULL,
      block_id TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS merge_runs (
      id TEXT PRIMARY KEY,
      lecture_id TEXT NOT NULL UNIQUE REFERENCES lectures(id),
      state TEXT NOT NULL DEFAULT 'pending',
      failed_window_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS window_results (
      id TEXT PRIMARY KEY,
      merge_run_id TEXT NOT NULL REFERENCES merge_runs(id),
      window_id TEXT NOT NULL,
      coverage_status TEXT NOT NULL DEFAULT 'pending',
      coverage_attempts INTEGER NOT NULL DEFAULT 0,
      coverage_last_error TEXT,
      conflict_status TEXT NOT NULL DEFAULT 'done',
      conflict_attempts INTEGER NOT NULL DEFAULT 0,
      conflict_last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS verdicts (
      id TEXT PRIMARY KEY,
      window_result_id TEXT NOT NULL REFERENCES window_results(id),
      question_key TEXT NOT NULL,
      chosen_label TEXT NOT NULL,
      probability REAL NOT NULL,
      confidence REAL,
      effective_label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS edit_list_entries (
      id TEXT PRIMARY KEY,
      merge_run_id TEXT NOT NULL REFERENCES merge_runs(id),
      type TEXT NOT NULL,
      window_id TEXT NOT NULL,
      source_ids TEXT NOT NULL DEFAULT '[]',
      note_id TEXT,
      retrieved_note_ids TEXT NOT NULL DEFAULT '[]',
      source_text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      merge_run_id TEXT NOT NULL REFERENCES merge_runs(id),
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      text TEXT NOT NULL,
      source_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'accepted',
      drop_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS merged_blocks (
      id TEXT PRIMARY KEY,
      merge_run_id TEXT NOT NULL REFERENCES merge_runs(id),
      position INTEGER NOT NULL,
      window_id TEXT,
      origin TEXT NOT NULL,
      note_id TEXT,
      text TEXT NOT NULL,
      original_text TEXT,
      proposed_rewrite TEXT,
      citations TEXT NOT NULL DEFAULT '[]',
      model_placed INTEGER NOT NULL DEFAULT 1,
      review_state TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS abbreviation_pairs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      abbreviation TEXT NOT NULL,
      expansion TEXT NOT NULL,
      match_case_exactly INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ignored_tokens (
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, token)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_files (
      id TEXT PRIMARY KEY,
      lecture_id TEXT NOT NULL REFERENCES lectures(id),
      file_index INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      recording_start_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audio_chunks (
      id TEXT PRIMARY KEY,
      audio_file_id TEXT NOT NULL REFERENCES audio_files(id),
      chunk_index INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      start_offset_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_runs (
      id TEXT PRIMARY KEY,
      lecture_id TEXT NOT NULL UNIQUE REFERENCES lectures(id),
      state TEXT NOT NULL DEFAULT 'running',
      model TEXT NOT NULL,
      failed_chunk_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sentences (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL REFERENCES audio_chunks(id),
      audio_start_offset_ms INTEGER NOT NULL,
      clock_start_time_ms INTEGER NOT NULL,
      text_raw TEXT NOT NULL,
      text TEXT NOT NULL,
      avg_logprob REAL NOT NULL,
      no_speech_prob REAL NOT NULL,
      compression_ratio REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      stitched_into TEXT,
      flag_state TEXT NOT NULL DEFAULT 'unflagged',
      flag_reasons TEXT NOT NULL DEFAULT '[]',
      corrected_text TEXT
    );
  `);

  // Additive migrations — safe to run repeatedly
  try { db.exec("ALTER TABLE users ADD COLUMN last_used_subject_id TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE lectures ADD COLUMN presentation_path TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE subjects ADD COLUMN glossary_terms TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE subjects ADD COLUMN guia_docente_path TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE lectures ADD COLUMN window_overrides TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE audio_files ADD COLUMN transcription_model TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE audio_chunks ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE audio_chunks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE audio_chunks ADD COLUMN last_error TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE audio_chunks ADD COLUMN raw_response TEXT"); } catch { /* already exists */ }

  return db;
}

export function ensureDefaultUser(db: Database.Database): User {
  const existing = db
    .prepare("SELECT id, created_at FROM users LIMIT 1")
    .get() as { id: string; created_at: number } | undefined;

  if (existing) {
    return { id: existing.id, createdAt: existing.created_at };
  }

  const id = "user-default";
  const createdAt = Date.now();
  db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(id, createdAt);
  return { id, createdAt };
}

export function createLecture(
  db: Database.Database,
  id: string,
  userId: string,
  dataDir: string,
): Lecture {
  const now = Date.now();
  db.prepare(
    `INSERT INTO lectures (id, user_id, stage, subject_id, data_dir, notes_data, created_at, updated_at)
     VALUES (?, ?, 'writing', NULL, ?, '{"blocks":[],"meta":{}}', ?, ?)`,
  ).run(id, userId, dataDir, now, now);

  return rowToLecture(
    db.prepare("SELECT * FROM lectures WHERE id = ?").get(id) as DbRow,
  );
}

export function getLecture(
  db: Database.Database,
  id: string,
): Lecture | undefined {
  const row = db
    .prepare("SELECT * FROM lectures WHERE id = ?")
    .get(id) as DbRow | undefined;
  return row ? rowToLecture(row) : undefined;
}

export function listLectures(db: Database.Database): Lecture[] {
  const rows = db
    .prepare("SELECT * FROM lectures ORDER BY created_at DESC")
    .all() as DbRow[];
  return rows.map(rowToLecture);
}

type MarkerRow = {
  id: string;
  lecture_id: string;
  timestamp: number;
  block_id: string;
};

function rowToMarker(row: MarkerRow): SlideMarker {
  return { id: row.id, lectureId: row.lecture_id, timestamp: row.timestamp, blockId: row.block_id };
}

export function createMarker(
  db: Database.Database,
  id: string,
  lectureId: string,
  timestamp: number,
  blockId: string,
): SlideMarker {
  db.prepare(
    "INSERT INTO slide_markers (id, lecture_id, timestamp, block_id) VALUES (?, ?, ?, ?)",
  ).run(id, lectureId, timestamp, blockId);
  return rowToMarker(
    db.prepare("SELECT * FROM slide_markers WHERE id = ?").get(id) as MarkerRow,
  );
}

export function listMarkers(
  db: Database.Database,
  lectureId: string,
): SlideMarker[] {
  const rows = db
    .prepare("SELECT * FROM slide_markers WHERE lecture_id = ? ORDER BY timestamp ASC")
    .all(lectureId) as MarkerRow[];
  return rows.map(rowToMarker);
}

export function deleteMarker(
  db: Database.Database,
  id: string,
  lectureId: string,
): boolean {
  const result = db
    .prepare("DELETE FROM slide_markers WHERE id = ? AND lecture_id = ?")
    .run(id, lectureId);
  return result.changes > 0;
}

export function updateLectureNotes(
  db: Database.Database,
  id: string,
  notesData: string,
): Lecture | undefined {
  const now = Date.now();
  const result = db
    .prepare(
      "UPDATE lectures SET notes_data = ?, updated_at = ? WHERE id = ?",
    )
    .run(notesData, now, id);

  if (result.changes === 0) return undefined;
  return getLecture(db, id);
}

// Subject functions

export function createSubject(
  db: Database.Database,
  id: string,
  name: string,
  userId: string,
): Subject {
  const now = Date.now();
  db.prepare(
    "INSERT INTO subjects (id, name, user_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, name, userId, now);
  return rowToSubject(
    db.prepare("SELECT * FROM subjects WHERE id = ?").get(id) as SubjectRow,
  );
}

export function listSubjects(db: Database.Database): Subject[] {
  return (db.prepare("SELECT * FROM subjects ORDER BY created_at ASC").all() as SubjectRow[]).map(rowToSubject);
}

export function getSubject(db: Database.Database, id: string): Subject | undefined {
  const row = db.prepare("SELECT * FROM subjects WHERE id = ?").get(id) as SubjectRow | undefined;
  return row ? rowToSubject(row) : undefined;
}

export function getLastUsedSubject(db: Database.Database): Subject | null {
  const user = db.prepare("SELECT last_used_subject_id FROM users LIMIT 1").get() as { last_used_subject_id: string | null } | undefined;
  if (!user?.last_used_subject_id) return null;
  const subject = getSubject(db, user.last_used_subject_id);
  return subject ?? null;
}

export function updateSubjectGlossary(
  db: Database.Database,
  subjectId: string,
  terms: string[],
  guiaPath: string,
): Subject | undefined {
  const result = db
    .prepare(
      "UPDATE subjects SET glossary_terms = ?, guia_docente_path = ? WHERE id = ?",
    )
    .run(JSON.stringify(terms), guiaPath, subjectId);
  if (result.changes === 0) return undefined;
  return getSubject(db, subjectId);
}

// Abbreviation dictionary functions

type AbbreviationPairRow = {
  id: string;
  user_id: string;
  abbreviation: string;
  expansion: string;
  match_case_exactly: number;
  created_at: number;
};

function rowToPair(row: AbbreviationPairRow): AbbreviationPair {
  return {
    id: row.id,
    userId: row.user_id,
    abbreviation: row.abbreviation,
    expansion: row.expansion,
    matchCaseExactly: row.match_case_exactly === 1,
    createdAt: row.created_at,
  };
}

export function listAbbreviationPairs(db: Database.Database): AbbreviationPair[] {
  return (db.prepare("SELECT * FROM abbreviation_pairs ORDER BY created_at ASC").all() as AbbreviationPairRow[]).map(rowToPair);
}

export function createAbbreviationPair(
  db: Database.Database,
  id: string,
  userId: string,
  abbreviation: string,
  expansion: string,
  matchCaseExactly: boolean,
): AbbreviationPair {
  const now = Date.now();
  db.prepare(
    "INSERT INTO abbreviation_pairs (id, user_id, abbreviation, expansion, match_case_exactly, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, userId, abbreviation, expansion, matchCaseExactly ? 1 : 0, now);
  return rowToPair(
    db.prepare("SELECT * FROM abbreviation_pairs WHERE id = ?").get(id) as AbbreviationPairRow,
  );
}

export function deleteAbbreviationPair(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM abbreviation_pairs WHERE id = ?").run(id);
  return result.changes > 0;
}

export function addIgnoredToken(
  db: Database.Database,
  userId: string,
  token: string,
): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO ignored_tokens (user_id, token, created_at) VALUES (?, ?, ?)",
  ).run(userId, token.toLowerCase(), now);
}

export function listIgnoredTokens(db: Database.Database, userId: string): ReadonlySet<string> {
  const rows = db.prepare("SELECT token FROM ignored_tokens WHERE user_id = ?").all(userId) as { token: string }[];
  return new Set(rows.map((r) => r.token));
}

// Window override helpers

export function getWindowOverrides(
  db: Database.Database,
  lectureId: string,
): WindowOverride[] | null {
  const row = db
    .prepare("SELECT window_overrides FROM lectures WHERE id = ?")
    .get(lectureId) as { window_overrides: string | null } | undefined;
  if (!row || row.window_overrides === null) return null;
  return JSON.parse(row.window_overrides) as WindowOverride[];
}

export function saveWindowOverrides(
  db: Database.Database,
  lectureId: string,
  overrides: WindowOverride[],
): void {
  db.prepare("UPDATE lectures SET window_overrides = ? WHERE id = ?")
    .run(JSON.stringify(overrides), lectureId);
}

export function updateLectureStage(
  db: Database.Database,
  lectureId: string,
  stage: string,
): void {
  const now = Date.now();
  db.prepare("UPDATE lectures SET stage = ?, updated_at = ? WHERE id = ?").run(stage, now, lectureId);
}

// Seal a lecture: set stage to "sealed", assign subject, store optional presentation path
export function sealLecture(
  db: Database.Database,
  lectureId: string,
  subjectId: string,
  presentationPath: string | null,
): Lecture | undefined {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE lectures SET stage = 'sealed', subject_id = ?, presentation_path = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(subjectId, presentationPath, now, lectureId);
  if (result.changes === 0) return undefined;
  db.prepare("UPDATE users SET last_used_subject_id = ?").run(subjectId);
  return getLecture(db, lectureId);
}

// Audio file and chunk helpers

type AudioFileRow = {
  id: string;
  lecture_id: string;
  file_index: number;
  file_path: string;
  recording_start_ms: number;
  duration_ms: number;
  created_at: number;
  transcription_model: string | null;
};

function rowToAudioFile(row: AudioFileRow): AudioFile {
  return {
    id: row.id,
    lectureId: row.lecture_id,
    fileIndex: row.file_index,
    filePath: row.file_path,
    recordingStartMs: row.recording_start_ms,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    transcriptionModel: row.transcription_model ?? null,
  };
}

export function createAudioFile(
  db: Database.Database,
  id: string,
  lectureId: string,
  fileIndex: number,
  filePath: string,
  recordingStartMs: number,
  durationMs: number,
): AudioFile {
  const now = Date.now();
  db.prepare(
    `INSERT INTO audio_files (id, lecture_id, file_index, file_path, recording_start_ms, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, lectureId, fileIndex, filePath, recordingStartMs, durationMs, now);
  return rowToAudioFile(
    db.prepare("SELECT * FROM audio_files WHERE id = ?").get(id) as AudioFileRow,
  );
}

export function listAudioFiles(db: Database.Database, lectureId: string): AudioFile[] {
  return (
    db
      .prepare("SELECT * FROM audio_files WHERE lecture_id = ? ORDER BY file_index ASC")
      .all(lectureId) as AudioFileRow[]
  ).map(rowToAudioFile);
}

type AudioChunkRow = {
  id: string;
  audio_file_id: string;
  chunk_index: number;
  file_path: string;
  start_offset_ms: number;
  duration_ms: number;
  status: string;
  attempts: number;
  last_error: string | null;
  raw_response: string | null;
};

function rowToAudioChunk(row: AudioChunkRow): AudioChunk {
  return {
    id: row.id,
    audioFileId: row.audio_file_id,
    chunkIndex: row.chunk_index,
    filePath: row.file_path,
    startOffsetMs: row.start_offset_ms,
    durationMs: row.duration_ms,
    status: (row.status ?? "pending") as ChunkStatus,
    attempts: row.attempts ?? 0,
    lastError: row.last_error ?? null,
    rawResponse: row.raw_response ?? null,
  };
}

export function createAudioChunk(
  db: Database.Database,
  id: string,
  audioFileId: string,
  chunkIndex: number,
  filePath: string,
  startOffsetMs: number,
  durationMs: number,
): AudioChunk {
  db.prepare(
    `INSERT INTO audio_chunks (id, audio_file_id, chunk_index, file_path, start_offset_ms, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, audioFileId, chunkIndex, filePath, startOffsetMs, durationMs);
  return rowToAudioChunk(
    db.prepare("SELECT * FROM audio_chunks WHERE id = ?").get(id) as AudioChunkRow,
  );
}

export function listAudioChunks(db: Database.Database, audioFileId: string): AudioChunk[] {
  return (
    db
      .prepare("SELECT * FROM audio_chunks WHERE audio_file_id = ? ORDER BY chunk_index ASC")
      .all(audioFileId) as AudioChunkRow[]
  ).map(rowToAudioChunk);
}

export function updateAudioChunkTranscription(
  db: Database.Database,
  id: string,
  status: ChunkStatus,
  rawResponse: string | null,
  error: string | null,
): void {
  db.prepare(
    `UPDATE audio_chunks SET status = ?, attempts = attempts + 1, raw_response = ?, last_error = ? WHERE id = ?`,
  ).run(status, rawResponse, error, id);
}

export function setAudioFileTranscriptionModel(
  db: Database.Database,
  id: string,
  model: string,
): void {
  db.prepare("UPDATE audio_files SET transcription_model = ? WHERE id = ?").run(model, id);
}

// ── Transcript run helpers ───────────────────────────────────────────────────

type TranscriptRunRow = {
  id: string;
  lecture_id: string;
  state: string;
  model: string;
  failed_chunk_ids: string;
  created_at: number;
};

function rowToTranscriptRun(row: TranscriptRunRow): TranscriptRun {
  return {
    id: row.id,
    lectureId: row.lecture_id,
    state: row.state as TranscriptRunState,
    model: row.model,
    failedChunkIds: JSON.parse(row.failed_chunk_ids) as string[],
    createdAt: row.created_at,
  };
}

export function createTranscriptRun(
  db: Database.Database,
  id: string,
  lectureId: string,
  model: string,
): TranscriptRun {
  const now = Date.now();
  db.prepare(
    `INSERT INTO transcript_runs (id, lecture_id, state, model, failed_chunk_ids, created_at)
     VALUES (?, ?, 'running', ?, '[]', ?)`,
  ).run(id, lectureId, model, now);
  return rowToTranscriptRun(
    db.prepare("SELECT * FROM transcript_runs WHERE id = ?").get(id) as TranscriptRunRow,
  );
}

export function getTranscriptRunByLectureId(
  db: Database.Database,
  lectureId: string,
): TranscriptRun | undefined {
  const row = db
    .prepare("SELECT * FROM transcript_runs WHERE lecture_id = ?")
    .get(lectureId) as TranscriptRunRow | undefined;
  return row ? rowToTranscriptRun(row) : undefined;
}

export function updateTranscriptRunState(
  db: Database.Database,
  id: string,
  state: TranscriptRunState,
  failedChunkIds?: string[],
): void {
  if (failedChunkIds !== undefined) {
    db.prepare("UPDATE transcript_runs SET state = ?, failed_chunk_ids = ? WHERE id = ?").run(
      state,
      JSON.stringify(failedChunkIds),
      id,
    );
  } else {
    db.prepare("UPDATE transcript_runs SET state = ? WHERE id = ?").run(state, id);
  }
}

// ── Sentence helpers ─────────────────────────────────────────────────────────

type SentenceRow = {
  id: string;
  chunk_id: string;
  audio_start_offset_ms: number;
  clock_start_time_ms: number;
  text_raw: string;
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio: number;
  status: string;
  stitched_into: string | null;
  flag_state: string;
  flag_reasons: string;
  corrected_text: string | null;
};

function rowToSentence(row: SentenceRow): Sentence {
  return {
    id: row.id,
    chunkId: row.chunk_id,
    audioStartOffsetMs: row.audio_start_offset_ms,
    clockStartTimeMs: row.clock_start_time_ms,
    textRaw: row.text_raw,
    text: row.text,
    avgLogprob: row.avg_logprob,
    noSpeechProb: row.no_speech_prob,
    compressionRatio: row.compression_ratio,
    status: (row.status ?? "active") as SentenceStatus,
    stitchedInto: row.stitched_into ?? null,
    flagState: (row.flag_state ?? "unflagged") as SentenceFlagState,
    flagReasons: JSON.parse(row.flag_reasons ?? "[]") as string[],
    correctedText: row.corrected_text ?? null,
  };
}

export function createSentence(
  db: Database.Database,
  sentence: Sentence,
): Sentence {
  db.prepare(
    `INSERT INTO sentences (id, chunk_id, audio_start_offset_ms, clock_start_time_ms, text_raw, text,
       avg_logprob, no_speech_prob, compression_ratio, status, stitched_into, flag_state, flag_reasons, corrected_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sentence.id,
    sentence.chunkId,
    sentence.audioStartOffsetMs,
    sentence.clockStartTimeMs,
    sentence.textRaw,
    sentence.text,
    sentence.avgLogprob,
    sentence.noSpeechProb,
    sentence.compressionRatio,
    sentence.status,
    sentence.stitchedInto,
    sentence.flagState,
    JSON.stringify(sentence.flagReasons),
    sentence.correctedText,
  );
  return rowToSentence(
    db.prepare("SELECT * FROM sentences WHERE id = ?").get(sentence.id) as SentenceRow,
  );
}

export function listSentencesByChunk(db: Database.Database, chunkId: string): Sentence[] {
  return (
    db.prepare("SELECT * FROM sentences WHERE chunk_id = ?").all(chunkId) as SentenceRow[]
  ).map(rowToSentence);
}

export function listSentencesByLecture(db: Database.Database, lectureId: string): Sentence[] {
  return (
    db
      .prepare(
        `SELECT s.* FROM sentences s
         JOIN audio_chunks ac ON s.chunk_id = ac.id
         JOIN audio_files af ON ac.audio_file_id = af.id
         WHERE af.lecture_id = ?
         ORDER BY s.clock_start_time_ms ASC`,
      )
      .all(lectureId) as SentenceRow[]
  ).map(rowToSentence);
}

// ── Merge helpers ────────────────────────────────────────────────────────────

type MergeRunRow = {
  id: string;
  lecture_id: string;
  state: string;
  failed_window_ids: string;
  created_at: number;
};

function rowToMergeRun(row: MergeRunRow): MergeRun {
  return {
    id: row.id,
    lectureId: row.lecture_id,
    state: row.state as MergeRunState,
    failedWindowIds: JSON.parse(row.failed_window_ids) as string[],
    createdAt: row.created_at,
  };
}

export function createMergeRun(
  db: Database.Database,
  id: string,
  lectureId: string,
): MergeRun {
  const now = Date.now();
  db.prepare(
    "INSERT INTO merge_runs (id, lecture_id, state, failed_window_ids, created_at) VALUES (?, ?, 'running', '[]', ?)",
  ).run(id, lectureId, now);
  return rowToMergeRun(
    db.prepare("SELECT * FROM merge_runs WHERE id = ?").get(id) as MergeRunRow,
  );
}

export function getMergeRunByLectureId(
  db: Database.Database,
  lectureId: string,
): MergeRun | undefined {
  const row = db
    .prepare("SELECT * FROM merge_runs WHERE lecture_id = ?")
    .get(lectureId) as MergeRunRow | undefined;
  return row ? rowToMergeRun(row) : undefined;
}

export function updateMergeRunState(
  db: Database.Database,
  id: string,
  state: MergeRunState,
): void {
  db.prepare("UPDATE merge_runs SET state = ? WHERE id = ?").run(state, id);
}

type WindowResultRow = {
  id: string;
  merge_run_id: string;
  window_id: string;
  coverage_status: string;
  coverage_attempts: number;
  coverage_last_error: string | null;
  conflict_status: string;
  conflict_attempts: number;
  conflict_last_error: string | null;
};

function rowToWindowResult(row: WindowResultRow): WindowResult {
  return {
    id: row.id,
    mergeRunId: row.merge_run_id,
    windowId: row.window_id,
    coverageStatus: row.coverage_status as WindowResultStatus,
    coverageAttempts: row.coverage_attempts,
    coverageLastError: row.coverage_last_error,
    conflictStatus: row.conflict_status as WindowResultStatus,
    conflictAttempts: row.conflict_attempts,
    conflictLastError: row.conflict_last_error,
  };
}

export function createWindowResult(
  db: Database.Database,
  id: string,
  mergeRunId: string,
  windowId: string,
): WindowResult {
  db.prepare(
    `INSERT INTO window_results (id, merge_run_id, window_id, coverage_status, coverage_attempts, conflict_status, conflict_attempts)
     VALUES (?, ?, ?, 'pending', 0, 'pending', 0)`,
  ).run(id, mergeRunId, windowId);
  return rowToWindowResult(
    db.prepare("SELECT * FROM window_results WHERE id = ?").get(id) as WindowResultRow,
  );
}

export function updateWindowResultCoverage(
  db: Database.Database,
  id: string,
  status: WindowResultStatus,
  error?: string,
): void {
  db.prepare(
    "UPDATE window_results SET coverage_status = ?, coverage_last_error = ?, coverage_attempts = coverage_attempts + 1 WHERE id = ?",
  ).run(status, error ?? null, id);
}

export function updateWindowResultConflict(
  db: Database.Database,
  id: string,
  status: WindowResultStatus,
  error?: string,
): void {
  db.prepare(
    "UPDATE window_results SET conflict_status = ?, conflict_last_error = ?, conflict_attempts = conflict_attempts + 1 WHERE id = ?",
  ).run(status, error ?? null, id);
}

export type VerdictInput = {
  id: string;
  questionKey: string;
  chosenLabel: string;
  probability: number;
  confidence?: number;
  effectiveLabel: string;
};

export function saveVerdicts(
  db: Database.Database,
  windowResultId: string,
  verdicts: VerdictInput[],
): void {
  const stmt = db.prepare(
    "INSERT INTO verdicts (id, window_result_id, question_key, chosen_label, probability, confidence, effective_label) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const v of verdicts) {
    stmt.run(v.id, windowResultId, v.questionKey, v.chosenLabel, v.probability, v.confidence ?? null, v.effectiveLabel);
  }
}

type EditListEntryRow = {
  id: string;
  merge_run_id: string;
  type: string;
  window_id: string;
  source_ids: string;
  note_id: string | null;
  retrieved_note_ids: string;
  source_text: string;
};

function rowToEditListEntry(row: EditListEntryRow): EditListEntry {
  return {
    id: row.id,
    mergeRunId: row.merge_run_id,
    type: row.type as EditListEntryType,
    windowId: row.window_id,
    sourceIds: JSON.parse(row.source_ids) as string[],
    noteId: row.note_id,
    retrievedNoteIds: JSON.parse(row.retrieved_note_ids) as string[],
    sourceText: row.source_text,
  };
}

export function createEditListEntry(
  db: Database.Database,
  entry: Omit<EditListEntry, "retrievedNoteIds"> & { retrievedNoteIds?: string[] },
): EditListEntry {
  db.prepare(
    `INSERT INTO edit_list_entries (id, merge_run_id, type, window_id, source_ids, note_id, retrieved_note_ids, source_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.mergeRunId,
    entry.type,
    entry.windowId,
    JSON.stringify(entry.sourceIds),
    entry.noteId ?? null,
    JSON.stringify(entry.retrievedNoteIds ?? []),
    entry.sourceText,
  );
  return rowToEditListEntry(
    db.prepare("SELECT * FROM edit_list_entries WHERE id = ?").get(entry.id) as EditListEntryRow,
  );
}

export function listEditListEntries(
  db: Database.Database,
  mergeRunId: string,
): EditListEntry[] {
  const rows = db
    .prepare("SELECT * FROM edit_list_entries WHERE merge_run_id = ?")
    .all(mergeRunId) as EditListEntryRow[];
  return rows.map(rowToEditListEntry);
}

type OperationRow = {
  id: string;
  merge_run_id: string;
  entry_id: string;
  kind: string;
  target: string;
  text: string;
  source_ids: string;
  status: string;
  drop_reason: string | null;
};

function rowToOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    mergeRunId: row.merge_run_id,
    entryId: row.entry_id,
    kind: row.kind as OperationKind,
    target: row.target,
    text: row.text,
    sourceIds: JSON.parse(row.source_ids) as string[],
    status: row.status as OperationStatus,
    dropReason: row.drop_reason,
  };
}

export function createOperation(
  db: Database.Database,
  op: Operation,
): Operation {
  db.prepare(
    `INSERT INTO operations (id, merge_run_id, entry_id, kind, target, text, source_ids, status, drop_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(op.id, op.mergeRunId, op.entryId, op.kind, op.target, op.text, JSON.stringify(op.sourceIds), op.status, op.dropReason ?? null);
  return rowToOperation(
    db.prepare("SELECT * FROM operations WHERE id = ?").get(op.id) as OperationRow,
  );
}

type MergedBlockRow = {
  id: string;
  merge_run_id: string;
  position: number;
  window_id: string | null;
  origin: string;
  note_id: string | null;
  text: string;
  original_text: string | null;
  proposed_rewrite: string | null;
  citations: string;
  model_placed: number;
  review_state: string | null;
};

function rowToMergedBlock(row: MergedBlockRow): MergedBlock {
  return {
    id: row.id,
    mergeRunId: row.merge_run_id,
    position: row.position,
    windowId: row.window_id,
    origin: row.origin as MergedBlockOrigin,
    noteId: row.note_id,
    text: row.text,
    originalText: row.original_text,
    proposedRewrite: row.proposed_rewrite,
    citations: JSON.parse(row.citations) as Citation[],
    modelPlaced: row.model_placed === 1,
    reviewState: row.review_state as MergedBlockReviewState | null,
  };
}

export function createMergedBlock(
  db: Database.Database,
  block: MergedBlock,
): MergedBlock {
  db.prepare(
    `INSERT INTO merged_blocks (id, merge_run_id, position, window_id, origin, note_id, text, original_text, proposed_rewrite, citations, model_placed, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    block.id,
    block.mergeRunId,
    block.position,
    block.windowId ?? null,
    block.origin,
    block.noteId ?? null,
    block.text,
    block.originalText ?? null,
    block.proposedRewrite ?? null,
    JSON.stringify(block.citations),
    block.modelPlaced ? 1 : 0,
    block.reviewState ?? null,
  );
  return rowToMergedBlock(
    db.prepare("SELECT * FROM merged_blocks WHERE id = ?").get(block.id) as MergedBlockRow,
  );
}

export function listMergedBlocks(
  db: Database.Database,
  mergeRunId: string,
): MergedBlock[] {
  const rows = db
    .prepare("SELECT * FROM merged_blocks WHERE merge_run_id = ? ORDER BY position ASC")
    .all(mergeRunId) as MergedBlockRow[];
  return rows.map(rowToMergedBlock);
}

export function getMergedBlock(
  db: Database.Database,
  blockId: string,
): MergedBlock | undefined {
  const row = db.prepare("SELECT * FROM merged_blocks WHERE id = ?").get(blockId) as MergedBlockRow | undefined;
  return row ? rowToMergedBlock(row) : undefined;
}

export function updateMergedBlockReviewState(
  db: Database.Database,
  blockId: string,
  reviewState: string,
): MergedBlock | undefined {
  db.prepare("UPDATE merged_blocks SET review_state = ? WHERE id = ?").run(reviewState, blockId);
  return getMergedBlock(db, blockId);
}

export function updateMergedBlockText(
  db: Database.Database,
  blockId: string,
  text: string,
): MergedBlock | undefined {
  db.prepare("UPDATE merged_blocks SET text = ? WHERE id = ?").run(text, blockId);
  return getMergedBlock(db, blockId);
}

export function hasReviewDecision(
  db: Database.Database,
  lectureId: string,
): boolean {
  const row = db.prepare(
    `SELECT 1 FROM merged_blocks mb
     JOIN merge_runs mr ON mb.merge_run_id = mr.id
     WHERE mr.lecture_id = ? AND mb.review_state IS NOT NULL
     LIMIT 1`,
  ).get(lectureId);
  return row !== undefined;
}

export function getAudioFileById(
  db: Database.Database,
  id: string,
): AudioFile | undefined {
  const row = db.prepare("SELECT * FROM audio_files WHERE id = ?").get(id) as AudioFileRow | undefined;
  return row ? rowToAudioFile(row) : undefined;
}

export function updateAudioFileRecordingStart(
  db: Database.Database,
  id: string,
  recordingStartMs: number,
): void {
  db.prepare("UPDATE audio_files SET recording_start_ms = ? WHERE id = ?").run(recordingStartMs, id);
}

// ── Export helpers ────────────────────────────────────────────────────────────

export function hasUnresolvedConflicts(
  db: Database.Database,
  lectureId: string,
): boolean {
  const row = db.prepare(
    `SELECT 1 FROM merged_blocks mb
     JOIN merge_runs mr ON mb.merge_run_id = mr.id
     WHERE mr.lecture_id = ? AND mb.origin = 'conflict' AND mb.review_state = 'unresolved'
     LIMIT 1`,
  ).get(lectureId);
  return row !== undefined;
}

export type FinalNoteBlock = { id: string; text: string };

export function computeFinalNoteBlocks(
  db: Database.Database,
  lectureId: string,
  mergeRunId: string,
): FinalNoteBlock[] {
  const markerRows = db.prepare(
    "SELECT block_id FROM slide_markers WHERE lecture_id = ?",
  ).all(lectureId) as { block_id: string }[];
  const markerBlockIds = new Set(markerRows.map((r) => r.block_id));

  const blocks = listMergedBlocks(db, mergeRunId);

  const result: FinalNoteBlock[] = [];
  for (const block of blocks) {
    if (block.reviewState === "reverted") continue;
    if (block.origin === "conflict" && block.reviewState === "unresolved") continue;
    if (block.origin === "student" && block.noteId !== null && markerBlockIds.has(block.noteId)) continue;
    result.push({ id: block.id, text: block.text });
  }
  return result;
}
