import type { Config } from "../server/config.js";
import type { Providers } from "./interfaces.js";
import { FakeClassifier, FakeNotion, FakeWritingModel, FakeSpeechToText } from "./fakes.js";
import { GroqSpeechToText } from "./groq.js";
import { JevClassifier } from "./jev.js";

export function createProviders(config: Config): Providers {
  const speechToText = config.groq.apiKey
    ? new GroqSpeechToText(config.groq.apiKey, config.transcriptionModel)
    : new FakeSpeechToText();

  const classifier = config.jev.apiKey
    ? new JevClassifier(config.jev.apiKey, config.jev.model)
    : new FakeClassifier();

  return {
    speechToText,
    classifier,
    writingModel: new FakeWritingModel(),
    notion: new FakeNotion(),
  };
}
