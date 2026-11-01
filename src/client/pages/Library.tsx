import { useState, useEffect } from "react";
import type { Lecture, LectureMode } from "../../shared/types.js";
import { strings } from "../../shared/strings.js";

interface LibraryProps {
  onOpen: (id: string) => void;
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 640, margin: "0 auto", padding: "2rem 1rem" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" },
  title: { fontSize: "1.5rem", fontWeight: 700 },
  button: { padding: "0.5rem 1rem", background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: "0.9rem" },
  list: { listStyle: "none" },
  item: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem 1rem", background: "#fff", border: "1px solid #e5e5e5", borderRadius: 8, marginBottom: "0.5rem" },
  date: { fontSize: "0.85rem", color: "#666" },
  openBtn: { padding: "0.25rem 0.75rem", background: "transparent", border: "1px solid #ccc", borderRadius: 4, cursor: "pointer", fontSize: "0.85rem" },
  empty: { color: "#888", textAlign: "center", marginTop: "3rem" },
};

export function Library({ onOpen }: LibraryProps) {
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<LectureMode>("live");

  useEffect(() => {
    fetch("/api/lectures")
      .then((r) => r.json())
      .then((data: Lecture[]) => {
        setLectures(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function createLecture() {
    const res = await fetch("/api/lectures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) return;
    const lecture: Lecture = await res.json();
    onOpen(lecture.id);
  }

  if (loading) return <div style={styles.container}>Loading...</div>;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>{strings.library.title}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <fieldset style={{ border: "none", display: "flex", gap: "0.75rem", fontSize: "0.85rem" }} data-testid="lecture-mode">
            <legend style={{ position: "absolute", left: -9999 }}>{strings.library.modeLabel}</legend>
            {(["live", "untimed"] as const).map((m) => (
              <label key={m} style={{ cursor: "pointer" }}>
                <input
                  type="radio"
                  name="lecture-mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  data-testid={`mode-${m}`}
                />{" "}
                {m === "live" ? strings.library.modeLive : strings.library.modeUntimed}
              </label>
            ))}
          </fieldset>
          <button style={styles.button} onClick={createLecture} data-testid="new-lecture">
            {strings.library.newLecture}
          </button>
        </div>
      </div>
      {lectures.length === 0 ? (
        <p style={styles.empty}>{strings.library.empty}</p>
      ) : (
        <ul style={styles.list}>
          {lectures.map((l) => (
            <li key={l.id} style={styles.item}>
              <span style={styles.date}>
                {strings.library.lectureDate}:{" "}
                {new Date(l.createdAt).toLocaleString()}
              </span>
              <button style={styles.openBtn} onClick={() => onOpen(l.id)} data-testid="open-lecture-button">
                {strings.library.openLecture}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
