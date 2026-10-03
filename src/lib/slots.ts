const TIME_ZONE = "America/New_York";
const HOURS = [9, 11, 13, 15];

export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone = TIME_ZONE,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(guess)
      .map((part) => [part.type, part.value]),
  );
  const hourValue = parts.hour === "24" ? "0" : parts.hour;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hourValue),
    Number(parts.minute),
  );
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

function addDays(year: number, month: number, day: number, days: number) {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function partsInZone(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

export function upcomingSlots(now: Date, taken: ReadonlySet<string>, timeZone = TIME_ZONE): string[] {
  const today = partsInZone(now, timeZone);
  const slots: string[] = [];

  for (let offset = 1; offset <= 12 && slots.length < 8; offset += 1) {
    const date = addDays(today.year, today.month, today.day, offset);
    const noon = zonedTimeToUtc(date.year, date.month, date.day, 12, timeZone);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(noon);
    if (weekday === "Sun") continue;

    for (const hour of HOURS) {
      const slot = zonedTimeToUtc(date.year, date.month, date.day, hour, timeZone);
      if (slot.getTime() <= now.getTime()) continue;
      const iso = slot.toISOString();
      if (taken.has(iso)) continue;
      slots.push(iso);
      if (slots.length === 8) break;
    }
  }

  return slots;
}

export function formatSlot(iso: string, timeZone = TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
