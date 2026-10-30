import { useState, useEffect } from "react";
import { Library } from "./pages/Library.js";
import { Write } from "./pages/Write.js";
import { Sources } from "./pages/Sources.js";
import { SubjectSettings } from "./pages/SubjectSettings.js";
import { Review } from "./pages/Review.js";
import { TranscriptCheck } from "./pages/TranscriptCheck.js";
import type { Lecture } from "../shared/types.js";

type View =
  | { name: "library" }
  | { name: "write"; lectureId: string }
  | { name: "sources"; lectureId: string }
  | { name: "subject-settings"; subjectId: string }
  | { name: "transcript-check"; lectureId: string }
  | { name: "review"; lectureId: string };

function parseView(): View {
  const hash = window.location.hash;
  const settingsMatch = hash.match(/^#\/subject-settings\/([^/]+)$/);
  if (settingsMatch && settingsMatch[1]) return { name: "subject-settings", subjectId: settingsMatch[1] };
  const reviewMatch = hash.match(/^#\/review\/([^/]+)$/);
  if (reviewMatch && reviewMatch[1]) return { name: "review", lectureId: reviewMatch[1] };
  const checkMatch = hash.match(/^#\/transcript-check\/([^/]+)$/);
  if (checkMatch && checkMatch[1]) return { name: "transcript-check", lectureId: checkMatch[1] };
  const sourcesMatch = hash.match(/^#\/sources\/([^/]+)$/);
  if (sourcesMatch && sourcesMatch[1]) return { name: "sources", lectureId: sourcesMatch[1] };
  const writeMatch = hash.match(/^#\/write\/([^/]+)$/);
  if (writeMatch && writeMatch[1]) return { name: "write", lectureId: writeMatch[1] };
  return { name: "library" };
}

export function App() {
  const [view, setView] = useState<View>(parseView);

  useEffect(() => {
    const onHashChange = () => setView(parseView());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function openLecture(id: string) {
    try {
      const res = await fetch(`/api/lectures/${id}`);
      if (res.ok) {
        const lecture = await res.json() as Lecture;
        switch (lecture.stage) {
          case "sources":
          case "sealed":
            window.location.hash = `/sources/${id}`;
            return;
          case "transcript-check":
          case "merge":
            window.location.hash = `/transcript-check/${id}`;
            return;
          case "review":
          case "exported":
            window.location.hash = `/review/${id}`;
            return;
        }
      }
    } catch { /* fall through to write */ }
    window.location.hash = `/write/${id}`;
  }

  function goToLibrary() {
    window.location.hash = "";
  }

  function goToSources(id: string) {
    window.location.hash = `/sources/${id}`;
  }

  function goToWrite(id: string) {
    window.location.hash = `/write/${id}`;
  }

  function goToTranscriptCheck(id: string) {
    window.location.hash = `/transcript-check/${id}`;
  }

  function goToReview(id: string) {
    window.location.hash = `/review/${id}`;
  }

  if (view.name === "write") {
    return (
      <Write
        lectureId={view.lectureId}
        onBack={goToLibrary}
        onContinueToSources={() => goToSources(view.lectureId)}
      />
    );
  }

  if (view.name === "sources") {
    return (
      <Sources
        lectureId={view.lectureId}
        onSealed={goToLibrary}
        onBack={() => goToWrite(view.lectureId)}
      />
    );
  }

  if (view.name === "subject-settings") {
    return (
      <SubjectSettings
        subjectId={view.subjectId}
        onBack={goToLibrary}
      />
    );
  }

  if (view.name === "transcript-check") {
    return (
      <TranscriptCheck
        lectureId={view.lectureId}
        onMergeStarted={() => goToReview(view.lectureId)}
        onBack={() => goToSources(view.lectureId)}
      />
    );
  }

  if (view.name === "review") {
    return (
      <Review
        lectureId={view.lectureId}
        onBack={goToLibrary}
      />
    );
  }

  return <Library onOpen={openLecture} />;
}
