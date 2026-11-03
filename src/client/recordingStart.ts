// Recording start times are entered as Europe/Madrid wall-clock time (the clock of all note events).
const ZONE = "Europe/Madrid";

const formatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});

/** Epoch ms → "YYYY-MM-DDTHH:mm:ss" in Madrid wall-clock time (a datetime-local value). */
export function msToMadridInput(ms: number): string {
  return formatter.format(new Date(ms)).replace(" ", "T");
}

function wallAsUtc(input: string): number {
  return Date.parse(input.length === 16 ? `${input}:00Z` : `${input}Z`);
}

/** "YYYY-MM-DDTHH:mm[:ss]" Madrid wall-clock time → epoch ms, or null when unparsable. */
export function madridInputToMs(input: string): number | null {
  const asUtc = wallAsUtc(input);
  if (Number.isNaN(asUtc)) return null;
  let guess = asUtc - (wallAsUtc(msToMadridInput(asUtc)) - asUtc);
  guess = asUtc - (wallAsUtc(msToMadridInput(guess)) - guess);
  return guess;
}
