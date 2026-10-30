import path from "path";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { createProviders } from "../providers/index.js";

const dataDir = path.resolve(config.dataDir);
const dbPath = path.join(dataDir, "notemerge.db");
const db = openDb(dbPath);

const providers = createProviders(config);

const app = createApp(db, dataDir, providers);

app.listen(config.port, () => {
  console.log(`NoteMerge server running on http://localhost:${config.port}`);
});
