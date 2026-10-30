import type { Config } from "../server/config.js";
import type { Providers } from "./interfaces.js";
import { FakeClassifier, FakeNotion, FakeWritingModel, FakeSpeechToText } from "./fakes.js";
import { GroqSpeechToText } from "./groq.js";
import { RealNotionProvider } from "./notion.js";

export function createProviders(config: Config): Providers {
  const speechToText = config.groq.apiKey
    ? new GroqSpeechToText(config.groq.apiKey, config.transcriptionModel)
    : new FakeSpeechToText();

  const notion =
    config.notion.clientId && config.notion.clientSecret
      ? new RealNotionProvider(config.notion.clientId, config.notion.clientSecret)
      : new FakeNotion();

  return {
    speechToText,
    classifier: new FakeClassifier(),
    writingModel: new FakeWritingModel(),
    notion,
  };
}
