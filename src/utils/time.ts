export function toHHMM(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

export function parseHHMM(hhmm: string): number | null {
  const trimmed = hhmm?.trim();
  if (!trimmed || trimmed.length !== 4) return null;
  const hh = Number(trimmed.slice(0, 2));
  const mm = Number(trimmed.slice(2, 4));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm; // minutes since midnight
}

export function diffMinutesHHMM(a: string, b: string): number | null {
  const ma = parseHHMM(a);
  const mb = parseHHMM(b);
  if (ma == null || mb == null) return null;
  // naive difference; if you care about crossing 0000, you can adjust later
  return ma - mb;
}
