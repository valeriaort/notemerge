import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";
import type { Lecture, User } from "../shared/types.js";

export type DbRow = {
  id: string;
  user_id: string;
  stage: string;
  subject_id: string | null;
  data_dir: string;
  notes_data: string;
  created_at: number;
  updated_at: number;
};

function rowToLecture(row: DbRow): Lecture {
  return {
    id: row.id,
    userId: row.user_id,
    stage: row.stage as Lecture["stage"],
    subjectId: row.subject_id,
    dataDir: row.data_dir,
    notesData: row.notes_data,
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

    CREATE TABLE IF NOT EXISTS lectures (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      stage TEXT NOT NULL DEFAULT 'writing',
      subject_id TEXT,
      data_dir TEXT NOT NULL,
      notes_data TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

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
     VALUES (?, ?, 'writing', NULL, ?, '[]', ?, ?)`,
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
