// Days as the API takes them: YYYY-MM-DD. The API refuses a preferred date before today in UTC,
// and a day already over on the phone's calendar makes no sense either: the first day offered is
// the later of the two (in a US evening, the UTC one is already tomorrow locally).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Today as the API counts it (UTC). */
export function utcToday(now: Date = new Date()): string {
  return isoDay(now);
}

/** Today on the phone's own calendar. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function addDays(day: string, count: number): string {
  return isoDay(new Date(Date.parse(day) + count * MS_PER_DAY));
}

/** The first day the customer can pick. ISO days compare as text. */
export function firstDay(now: Date = new Date()): string {
  const utc = utcToday(now);
  const local = localToday(now);
  return local > utc ? local : utc;
}

/** The days the customer can pick: `count` of them from the first one. */
export function offeredDays(count: number, now: Date = new Date()): string[] {
  const first = firstDay(now);
  return Array.from({ length: count }, (_, index) => addDays(first, index));
}

/** A day no longer offered: the API would refuse it, or it is over on the phone's calendar. */
export function isPastDay(day: string, now: Date = new Date()): boolean {
  return day < firstDay(now);
}

// A day is midnight UTC: format it in UTC so no time zone moves it to the day before.
const format = (day: string, locale: string, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(day));

/** "Friday, October 31" (or the locale's own order). */
export function formatLongDay(day: string, locale: string): string {
  return format(day, locale, { weekday: "long", month: "long", day: "numeric" });
}

/** The parts a day bubble shows: "Fri", "31", "Oct". */
export function dayParts(day: string, locale: string) {
  return {
    weekday: format(day, locale, { weekday: "short" }),
    date: format(day, locale, { day: "numeric" }),
    month: format(day, locale, { month: "short" }),
  };
}
