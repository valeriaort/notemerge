import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";
import type { AbbreviationPair, Lecture, SlideMarker, Subject, User } from "../shared/types.js";

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
};

function rowToSubject(row: SubjectRow): Subject {
  return { id: row.id, name: row.name, userId: row.user_id, createdAt: row.created_at };
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

  // Additive migrations — safe to run repeatedly
  try { db.exec("ALTER TABLE users ADD COLUMN last_used_subject_id TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE lectures ADD COLUMN presentation_path TEXT"); } catch { /* already exists */ }

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

// Seal a lecture: set stage to "sealed", assign subject, store presentation path
export function sealLecture(
  db: Database.Database,
  lectureId: string,
  subjectId: string,
  presentationPath: string,
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
