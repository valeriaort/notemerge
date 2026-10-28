import { useState, useEffect } from "react";
import { Library } from "./pages/Library.js";
import { Write } from "./pages/Write.js";
import { Sources } from "./pages/Sources.js";
import { SubjectSettings } from "./pages/SubjectSettings.js";

type View =
  | { name: "library" }
  | { name: "write"; lectureId: string }
  | { name: "sources"; lectureId: string }
  | { name: "subject-settings"; subjectId: string };

function parseView(): View {
  const hash = window.location.hash;
  const settingsMatch = hash.match(/^#\/subject-settings\/([^/]+)$/);
  if (settingsMatch && settingsMatch[1]) return { name: "subject-settings", subjectId: settingsMatch[1] };
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

  function openLecture(id: string) {
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

  return <Library onOpen={openLecture} />;
}
