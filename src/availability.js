const persianDigits = "۰۱۲۳۴۵۶۷۸۹";

export function toAsciiDigits(value) {
  return [...String(value)].map((c) => {
    const i = persianDigits.indexOf(c);
    return i === -1 ? c : String(i);
  }).join("");
}

export function validateJalaliDate(value) {
  const date = toAsciiDigits(value).replaceAll("/", "-");
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date);
  if (!match) throw new Error("Date must be Jalali YYYY-MM-DD, for example 1405-05-25");
  const [, year, month, day] = match.map(Number);
  const maxDay = month <= 6 ? 31 : month <= 11 ? 30 : 30;
  if (year < 1300 || year > 1500 || month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw new Error(`Invalid Jalali date: ${value}`);
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDirection(value = "qom-tehran") {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  const routes = {
    "qom-tehran": { fromCode: "QUM", toCode: "THR", from: "قم", to: "تهران" },
    "tehran-qom": { fromCode: "THR", toCode: "QUM", from: "تهران", to: "قم" },
    "قم-تهران": { fromCode: "QUM", toCode: "THR", from: "قم", to: "تهران" },
    "تهران-قم": { fromCode: "THR", toCode: "QUM", from: "تهران", to: "قم" }
  };
  if (!routes[normalized]) throw new Error("Direction must be qom-tehran or tehran-qom");
  return routes[normalized];
}

export function classifyPageText(text) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  const availableWords = /(?:انتخاب\s*(?:بلیط|قطار)|رزرو\s*(?:بلیط|قطار)|ظرفیت\s*[۱-۹1-9]|[۱-۹1-9]\s*(?:صندلی|نفر))/;
  const unavailableWords = /(?:تکمیل\s*ظرفیت|ظرفیت\s*تکمیل|ناموجود|بلیطی\s*(?:یافت|پیدا)\s*نشد|قطاری\s*(?:یافت|پیدا)\s*نشد)/;
  return {
    available: availableWords.test(compact) && !(/^.{0,80}(?:بلیطی|قطاری).{0,30}نشد/.test(compact)),
    soldOut: unavailableWords.test(compact),
    text: compact
  };
}

export function buildSearchUrl(route, date) {
  const query = new URLSearchParams({
    adult: "1",
    child: "0",
    infant: "0",
    departing: date,
    ticketType: "Family",
    isExclusive: "false"
  });
  return `https://www.alibaba.ir/train/${route.fromCode}-${route.toCode}?${query}`;
}

export function validateTime(value, name = "time") {
  const normalized = toAsciiDigits(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    throw new Error(`${name} must be HH:MM (00:00 to 23:59)`);
  }
  return normalized;
}

export function timeInRange(time, from = "00:00", to = "23:59") {
  return time >= from && time <= to;
}

export function jalaliMonthLength(year, month) {
  if (month >= 1 && month <= 6) return 31;
  if (month >= 7 && month <= 11) return 30;
  if (month !== 12) throw new Error(`Invalid Jalali month: ${month}`);
  const leapRemainders = new Set([1, 5, 9, 13, 17, 22, 26, 30]);
  return leapRemainders.has(year % 33) ? 30 : 29;
}

export function jalaliDateOptions(now = new Date()) {
  const numeric = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const currentParts = Object.fromEntries(numeric.formatToParts(now).map((part) => [part.type, part.value]));
  const year = Number(currentParts.year);
  const currentMonth = Number(currentParts.month);
  const currentDay = Number(currentParts.day);
  const names = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
  const yearLabel = new Intl.NumberFormat("fa-IR", { useGrouping: false }).format(year);
  const months = [];
  const lastMonth = Math.min(12, currentMonth + 2);
  for (let month = currentMonth; month <= lastMonth; month++) {
    const startDay = month === currentMonth ? currentDay : 1;
    const endDay = jalaliMonthLength(year, month);
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const days = [];
    for (let day = startDay; day <= endDay; day++) {
      days.push({ value: `${key}-${String(day).padStart(2, "0")}`, day });
    }
    months.push({ key, label: `${names[month - 1]} ${yearLabel}`, days });
  }
  return months;
}

export function getCurrentJalaliDateTime() {
  const numeric = new Intl.DateTimeFormat("en-US-u-ca-persian", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(numeric.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
