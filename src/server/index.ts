import path from "path";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { createFakeProviders } from "../providers/fakes.js";

const dataDir = path.resolve(config.dataDir);
const dbPath = path.join(dataDir, "notemerge.db");
const db = openDb(dbPath);

// In production, real providers would be wired in here.
// For now, fakes are used; later tickets will inject real providers.
const providers = createFakeProviders();

const app = createApp(db, dataDir, providers);

app.listen(config.port, () => {
  console.log(`NoteMerge server running on http://localhost:${config.port}`);
});
