import { createReadStream } from "fs";
import { Writable } from "stream";
import FormData from "form-data";
import type { SpeechToTextProvider } from "./interfaces.js";
import { TranscriptionHttpError } from "./interfaces.js";
import type { TranscriptionResult, WhisperSegment } from "../shared/types.js";

interface GroqVerboseSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio: number;
}

interface GroqVerboseResponse {
  segments: GroqVerboseSegment[];
}

function collectFormData(form: FormData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });
    sink.on("finish", () => resolve(Buffer.concat(chunks)));
    sink.on("error", reject);
    form.on("error", reject);
    form.pipe(sink);
  });
}

export class GroqSpeechToText implements SpeechToTextProvider {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "whisper-large-v3") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async transcribeChunk(chunkPath: string, prompt: string): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", createReadStream(chunkPath), { filename: "chunk.wav" });
    form.append("model", this.model);
    form.append("language", "es");
    form.append("response_format", "verbose_json");
    if (prompt) {
      form.append("prompt", prompt);
    }

    const buffer = await collectFormData(form);

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...form.getHeaders(),
      },
      body: buffer as unknown as BodyInit,
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = await response.text();
        if (body) message = body;
      } catch {
        // keep statusText
      }
      throw new TranscriptionHttpError(response.status, message);
    }

    const data = (await response.json()) as GroqVerboseResponse;

    const segments: WhisperSegment[] = (data.segments ?? []).map((seg) => ({
      startMs: Math.round(seg.start * 1000),
      endMs: Math.round(seg.end * 1000),
      text: seg.text,
      avgLogprob: seg.avg_logprob,
      noSpeechProb: seg.no_speech_prob,
      compressionRatio: seg.compression_ratio,
    }));

    return { segments };
  }
}
