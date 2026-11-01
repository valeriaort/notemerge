import type { Config } from "../server/config.js";
import type { EmbeddingProvider, Providers } from "./interfaces.js";
import type Database from "better-sqlite3";
import { FakeClassifier, FakeEmbeddingProvider, FakeNotion, FakeWritingModel, FakeSpeechToText } from "./fakes.js";
import { GroqSpeechToText } from "./groq.js";
import { JevClassifier } from "./jev.js";
import { AnthropicWritingModel } from "./haiku.js";
import { RealNotionProvider } from "./notion.js";
import { CachedEmbeddingProvider, LocalBgeM3Embedder, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";

export function createProviders(config: Config, db?: Database.Database): Providers {
  const speechToText = config.groq.apiKey
    ? new GroqSpeechToText(config.groq.apiKey, config.transcriptionModel)
    : new FakeSpeechToText();

  const classifier = config.jev.apiKey
    ? new JevClassifier(config.jev.apiKey, config.jev.model)
    : new FakeClassifier();

  const writingModel = config.haiku?.apiKey
    ? new AnthropicWritingModel(config.haiku.apiKey, config.haiku.model)
    : new FakeWritingModel();

  const notion =
    config.notion.clientId && config.notion.clientSecret
      ? new RealNotionProvider(config.notion.clientId, config.notion.clientSecret)
      : new FakeNotion();

  const embeddingModel = config.embeddings?.model ?? DEFAULT_EMBEDDING_MODEL;
  let embeddings: EmbeddingProvider =
    config.embeddings?.provider === "fake"
      ? new FakeEmbeddingProvider()
      : new LocalBgeM3Embedder(config.dataDir, embeddingModel);
  if (db) embeddings = new CachedEmbeddingProvider(embeddings, db, embeddingModel);

  return {
    speechToText,
    classifier,
    writingModel,
    notion,
    embeddings,
  };
}
