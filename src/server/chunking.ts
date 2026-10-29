import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { mkdirSync, existsSync } from "fs";

const execAsync = promisify(exec);

export type AudioChunkInfo = {
  id: string;           // e.g. "A01-C001"
  filePath: string;
  startOffsetMs: number;
  durationMs: number;
};

export type ChunkingResult =
  | { ok: true; chunks: AudioChunkInfo[]; durationMs: number }
  | { ok: false; error: string };

async function getAudioDurationSec(audioPath: string): Promise<number> {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
  );
  const secs = parseFloat(stdout.trim());
  if (isNaN(secs) || secs <= 0) throw new Error("Could not determine audio duration");
  return secs;
}

async function detectSilenceEndsSec(audioPath: string): Promise<number[]> {
  try {
    const { stderr } = await execAsync(
      `ffmpeg -i "${audioPath}" -af "silencedetect=noise=-40dB:d=0.3" -f null - 2>&1 || true`,
      { shell: "/bin/bash" },
    );
    const ends: number[] = [];
    const re = /silence_end:\s*([\d.]+)/g;
    let m;
    while ((m = re.exec(stderr)) !== null) {
      ends.push(parseFloat(m[1]!));
    }
    return ends;
  } catch {
    return [];
  }
}

// Find cut points (in seconds) at natural pauses near N*chunkTargetSec boundaries.
// Falls back to exact boundary when no silence is found within ±searchWindowSec (speech-detection
// fallback for noisy rooms where silence detection yields nothing near a target).
function computeCutPoints(
  durationSec: number,
  silenceEndsSec: number[],
  chunkTargetSec: number,
  searchWindowSec: number = 30,
): number[] {
  const cuts: number[] = [];
  let target = chunkTargetSec;
  while (target < durationSec - 1) {
    const candidates = silenceEndsSec.filter(
      (p) => Math.abs(p - target) <= searchWindowSec,
    );
    let cut: number;
    if (candidates.length > 0) {
      cut = candidates.reduce((a, b) =>
        Math.abs(a - target) <= Math.abs(b - target) ? a : b,
      );
    } else {
      // Speech-detection fallback: fixed boundary
      cut = target;
    }
    cuts.push(cut);
    target = cut + chunkTargetSec;
  }
  return cuts;
}

// Format chunk ID: A01-C001 (audioIndex and chunkIndex are 1-based)
function chunkId(audioIndex: number, chunkIndex: number): string {
  const a = String(audioIndex).padStart(2, "0");
  const c = String(chunkIndex).padStart(3, "0");
  return `A${a}-C${c}`;
}

export async function chunkAudioFile(
  audioPath: string,
  outputDir: string,
  audioIndex: number,
  chunkTargetMs: number,
): Promise<ChunkingResult> {
  mkdirSync(outputDir, { recursive: true });

  let durationSec: number;
  try {
    durationSec = await getAudioDurationSec(audioPath);
  } catch (err) {
    return { ok: false, error: `ffprobe failed: ${String(err)}` };
  }

  const chunkTargetSec = chunkTargetMs / 1000;
  const silenceEnds = await detectSilenceEndsSec(audioPath);
  const cutPoints = computeCutPoints(durationSec, silenceEnds, chunkTargetSec);

  // Build segment boundaries: [0, cut1, cut2, ..., durationSec]
  const boundaries = [0, ...cutPoints, durationSec];

  const chunks: AudioChunkInfo[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    const duration = end - start;
    if (duration <= 0) continue;

    const index = i + 1;
    const id = chunkId(audioIndex, index);
    const ext = path.extname(audioPath) || ".wav";
    const chunkPath = path.join(outputDir, `${id}${ext}`);

    try {
      await execAsync(
        `ffmpeg -i "${audioPath}" -ss ${start} -t ${duration} -c copy -y "${chunkPath}" 2>&1`,
        { shell: "/bin/bash" },
      );
    } catch (err) {
      return { ok: false, error: `ffmpeg cut failed for chunk ${id}: ${String(err)}` };
    }

    if (!existsSync(chunkPath)) {
      return { ok: false, error: `Chunk file not created: ${chunkPath}` };
    }

    chunks.push({
      id,
      filePath: chunkPath,
      startOffsetMs: Math.round(start * 1000),
      durationMs: Math.round(duration * 1000),
    });
  }

  if (chunks.length === 0) {
    return { ok: false, error: "No chunks produced from audio file" };
  }

  return { ok: true, chunks, durationMs: Math.round(durationSec * 1000) };
}
