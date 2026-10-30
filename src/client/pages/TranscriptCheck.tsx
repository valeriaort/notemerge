import { useState, useEffect, useRef, useCallback } from "react";
import type { Sentence } from "../../shared/types.js";
import { strings } from "../../shared/strings.js";

interface CheckState {
  queue: Sentence[];
  handled: number;
  total: number;
}

interface TranscriptCheckProps {
  lectureId: string;
  onMergeStarted: () => void;
  onBack: () => void;
}

export function TranscriptCheck({ lectureId, onMergeStarted, onBack }: TranscriptCheckProps) {
  const [state, setState] = useState<CheckState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [correctionText, setCorrectionText] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const correctionInputRef = useRef<HTMLInputElement | null>(null);

  const currentSentence = state?.queue[0] ?? null;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/lectures/${lectureId}/transcript-check`);
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setError(body.error ?? "Failed to load check status.");
        return;
      }
      const data = await res.json() as CheckState;
      setState(data);
      if (data.queue.length === 0) {
        // No flags — skip straight to merge
        await triggerMerge();
      }
    } catch {
      setError("Failed to load transcript check.");
    }
  }, [lectureId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function triggerMerge() {
    try {
      const res = await fetch(`/api/lectures/${lectureId}/transcript-check/skip`, {
        method: "POST",
      });
      if (res.ok) {
        onMergeStarted();
      }
    } catch {
      setError("Failed to start merge.");
    }
  }

  function playAudio() {
    if (!currentSentence) return;
    const url = `/api/lectures/${lectureId}/sentences/${currentSentence.id}/audio-clip`;
    if (audioRef.current) {
      audioRef.current.pause();
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    const startSec = Math.max(0, currentSentence.audioStartOffsetMs / 1000 - 3);
    audio.addEventListener("loadedmetadata", () => {
      audio.currentTime = startSec;
      void audio.play();
    });
    audio.load();
  }

  async function advance() {
    if (!currentSentence || isSubmitting) return;
    setIsSubmitting(true);
    setIsEditing(false);
    setCorrectionText("");
    try {
      const res = await fetch(`/api/lectures/${lectureId}/sentences/${currentSentence.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "advance" }),
      });
      const body = await res.json() as { mergeStarted?: boolean };
      if (body.mergeStarted) {
        onMergeStarted();
        return;
      }
      await load();
    } catch {
      setError("Failed to advance sentence.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function correct() {
    if (!currentSentence || isSubmitting || !correctionText.trim()) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/lectures/${lectureId}/sentences/${currentSentence.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "correct", correctedText: correctionText.trim() }),
      });
      const body = await res.json() as { mergeStarted?: boolean };
      if (body.mergeStarted) {
        onMergeStarted();
        return;
      }
      setIsEditing(false);
      setCorrectionText("");
      await load();
    } catch {
      setError("Failed to correct sentence.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function skip() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/lectures/${lectureId}/transcript-check/skip`, {
        method: "POST",
      });
      if (res.ok) {
        onMergeStarted();
      } else {
        const body = await res.json() as { error?: string };
        setError(body.error ?? "Skip failed.");
      }
    } catch {
      setError("Skip failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // Keyboard handler
  useEffect(() => {
    if (!state || state.queue.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (isEditing) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        playAudio();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void advance();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, isEditing, currentSentence]);

  if (error) {
    return (
      <div data-testid="transcript-check-error">
        <p>{error}</p>
        <button onClick={onBack}>Back</button>
      </div>
    );
  }

  if (!state) {
    return <div data-testid="transcript-check-loading">Loading…</div>;
  }

  if (state.queue.length === 0 && state.total === 0) {
    return <div data-testid="transcript-check-empty">No flagged sentences. Starting merge…</div>;
  }

  if (state.queue.length === 0) {
    return (
      <div data-testid="transcript-check-done">
        <p>All flags handled. Starting merge…</p>
      </div>
    );
  }

  const sentence = currentSentence!;

  return (
    <div data-testid="transcript-check-screen">
      <div data-testid="progress-indicator">
        {strings.transcriptCheck.progressLabel(state.handled, state.total)}
      </div>

      <div data-testid="flag-reasons">
        {sentence.flagReasons.join(", ")}
      </div>

      <div data-testid="sentence-text">
        {sentence.text}
      </div>

      {!isEditing ? (
        <button
          data-testid="edit-button"
          onClick={() => {
            setIsEditing(true);
            setCorrectionText(sentence.text);
            setTimeout(() => correctionInputRef.current?.focus(), 0);
          }}
        >
          {strings.transcriptCheck.correctLabel}
        </button>
      ) : (
        <div data-testid="correction-form">
          <input
            ref={correctionInputRef}
            data-testid="correction-input"
            value={correctionText}
            onChange={(e) => setCorrectionText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void correct();
              } else if (e.key === "Escape") {
                setIsEditing(false);
                setCorrectionText("");
              }
            }}
          />
          <button data-testid="save-correction" onClick={() => void correct()} disabled={isSubmitting}>
            Save
          </button>
          <button onClick={() => { setIsEditing(false); setCorrectionText(""); }}>
            Cancel
          </button>
        </div>
      )}

      <button
        data-testid="play-button"
        onClick={playAudio}
        title="Space to play"
      >
        {strings.transcriptCheck.playLabel}
      </button>

      <button
        data-testid="advance-button"
        onClick={() => void advance()}
        disabled={isSubmitting}
        title="Enter to advance"
      >
        {strings.transcriptCheck.advanceLabel}
      </button>

      <button
        data-testid="skip-button"
        onClick={() => void skip()}
        disabled={isSubmitting}
      >
        {strings.transcriptCheck.skipButton}
      </button>
    </div>
  );
}
