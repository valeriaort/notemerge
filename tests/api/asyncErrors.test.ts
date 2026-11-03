import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";
import { strings } from "../../src/shared/strings.js";
import FormData from "form-data";
import { readdirSync, readFileSync } from "fs";
import path from "path";

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(() => {
  server.close();
});

describe("errors in async routes", () => {
  it("answers 500 JSON { error } and keeps serving when async work throws", async () => {
    // A closed database makes getLecture throw inside the async Sources handler
    server.db.close();
    const form = new FormData();
    form.append("notes", Buffer.from("# Notes"), { filename: "notes.md", contentType: "text/markdown" });
    const res = await fetch(`${server.url}/api/lectures/any-id/sources`, {
      method: "POST",
      headers: form.getHeaders() as Record<string, string>,
      body: form.getBuffer(),
      signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: strings.errors.internal });

    // The server survived the rejection and still answers
    const next = await fetch(`${server.url}/api/nope`, { signal: AbortSignal.timeout(5000) });
    expect(next.status).toBe(404);
  });
});

describe("route files", () => {
  it("leave no async handler unwrapped", () => {
    const dir = path.resolve("src/server/routes");
    for (const file of readdirSync(dir)) {
      const src = readFileSync(path.join(dir, file), "utf8");
      const unwrapped = src.match(/(?<!asyncHandler\()\basync\s*\(/g) ?? [];
      expect(unwrapped, file).toEqual([]);
    }
  });
});
