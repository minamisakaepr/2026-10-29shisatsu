// 時刻の計算（タイムゾーンは設定値 timezone で受け取る）。純粋な関数。

/** その日時の、タイムゾーンでの年月日・時分・曜日 */
export function zonedParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), weekday: weekdays.indexOf(p.weekday),
  };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** "06:00-08:00" の時間帯に入っているか（終わりの時刻は含まない。日をまたぐ "22:00-02:00" にも対応） */
export function inTimeRange(d: Date, range: string, tz: string): boolean {
  const [a, b] = range.split("-");
  const { hour, minute } = zonedParts(d, tz);
  const now = hour * 60 + minute;
  const start = toMin(a);
  const end = toMin(b);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** タイムゾーンの「その日の HH:MM」を Date にする */
function zonedDateAt(year: number, month: number, day: number, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  // まず UTC として作り、タイムゾーンとのずれを2回補正する（夏時間のある地域にも対応）
  let t = Date.UTC(year, month - 1, day, h, m);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    t += Date.UTC(year, month - 1, day, h, m) - shown;
  }
  return new Date(t);
}

/** パシリへの送金予定日時 */
export function payoutScheduledAt(now: Date, timing: "same_day" | "next_day" | "weekly", hour: string, tz: string): Date {
  if (timing === "same_day") return now;
  const p = zonedParts(now, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const addDays = timing === "next_day" ? 1 : ((8 - p.weekday) % 7 || 7); // weekly = 次の月曜
  base.setUTCDate(base.getUTCDate() + addDays);
  return zonedDateAt(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, tz);
}

/** タイムゾーンでの、その月の1日 0:00 */
export function startOfMonth(now: Date, tz: string): Date {
  const p = zonedParts(now, tz);
  return zonedDateAt(p.year, p.month, 1, "00:00", tz);
}

/** タイムゾーンでの日付（YYYY-MM-DD） */
export function zonedDate(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
