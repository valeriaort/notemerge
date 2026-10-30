import type { Config } from "../server/config.js";
import type { Providers } from "./interfaces.js";
import { FakeClassifier, FakeNotion, FakeWritingModel, FakeSpeechToText } from "./fakes.js";
import { GroqSpeechToText } from "./groq.js";

export function createProviders(config: Config): Providers {
  const speechToText = config.groq.apiKey
    ? new GroqSpeechToText(config.groq.apiKey, config.transcriptionModel)
    : new FakeSpeechToText();

  return {
    speechToText,
    classifier: new FakeClassifier(),
    writingModel: new FakeWritingModel(),
    notion: new FakeNotion(),
  };
}
