import { describe, it, expect } from "vitest";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import { openDb, ensureDefaultUser, createLecture, createAudioFile, createAudioChunk } from "../../src/server/db.js";

describe("sentences lecture-scoped key migration", () => {
  it("keeps rows of a database whose sentences table is keyed by id alone", () => {
    const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "nm-mig-")), "app.db");
    const first = openDb(dbPath);
    first.pragma("foreign_keys = OFF");
    const user = ensureDefaultUser(first);
    createLecture(first, "L1", user.id, "/x");
    createAudioFile(first, "af1", "L1", 1, "/a", 0, 1000);
    createAudioChunk(first, "ac1", "af1", 1, "/c", 0, 1000);
    first.exec(`
      DROP TABLE sentences;
      CREATE TABLE sentences (
        id TEXT PRIMARY KEY, chunk_id TEXT NOT NULL REFERENCES audio_chunks(id),
        audio_start_offset_ms INTEGER NOT NULL, clock_start_time_ms INTEGER NOT NULL,
        text_raw TEXT NOT NULL, text TEXT NOT NULL, avg_logprob REAL NOT NULL,
        no_speech_prob REAL NOT NULL, compression_ratio REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', stitched_into TEXT,
        flag_state TEXT NOT NULL DEFAULT 'unflagged', flag_reasons TEXT NOT NULL DEFAULT '[]',
        corrected_text TEXT
      );
      INSERT INTO sentences (id, chunk_id, audio_start_offset_ms, clock_start_time_ms, text_raw, text, avg_logprob, no_speech_prob, compression_ratio)
        VALUES ('A01-T0001', 'ac1', 0, 0, 'Hola.', 'Hola.', -0.3, 0.1, 1.0);
    `);
    first.close();

    const db = openDb(dbPath);
    const rows = db.prepare("SELECT lecture_id, id, text FROM sentences").all();
    expect(rows).toEqual([{ lecture_id: "L1", id: "A01-T0001", text: "Hola." }]);
    db.close();
    expect(() => openDb(dbPath).close()).not.toThrow();
  });
});
