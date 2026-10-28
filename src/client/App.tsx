import { useState, useEffect } from "react";
import { Library } from "./pages/Library.js";
import { Write } from "./pages/Write.js";

type View =
  | { name: "library" }
  | { name: "write"; lectureId: string };

function parseView(): View {
  const hash = window.location.hash;
  const match = hash.match(/^#\/write\/([^/]+)$/);
  if (match && match[1]) return { name: "write", lectureId: match[1] };
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

  if (view.name === "write") {
    return <Write lectureId={view.lectureId} onBack={goToLibrary} />;
  }

  return <Library onOpen={openLecture} />;
}
