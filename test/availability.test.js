import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchUrl,
  classifyPageText,
  jalaliDateOptions,
  jalaliMonthLength,
  parseDirection,
  timeInRange,
  validateTime,
  validateJalaliDate
} from "../src/availability.js";
import { matchingTrain } from "../src/alibaba.js";

test("normalizes Persian Jalali dates", () => {
  assert.equal(validateJalaliDate("۱۴۰۵/۵/۲۵"), "1405-05-25");
  assert.throws(() => validateJalaliDate("2026-08-16"), /Invalid Jalali/);
});

test("supports both route directions", () => {
  assert.equal(parseDirection("qom-tehran").fromCode, "QUM");
  assert.equal(parseDirection("تهران-قم").toCode, "QUM");
});

test("recognizes availability and sold-out text", () => {
  assert.equal(classifyPageText("قطار رجا 08:20 انتخاب بلیط ۲ صندلی").available, true);
  assert.equal(classifyPageText("خرید بلیط قطار با بهترین قیمت").available, false);
  assert.equal(classifyPageText("برای این روز قطاری پیدا نشد - تکمیل ظرفیت").available, false);
  assert.equal(classifyPageText("برای این روز قطاری پیدا نشد - تکمیل ظرفیت").soldOut, true);
});

test("builds Alibaba train URL", () => {
  const url = buildSearchUrl(parseDirection("qom-tehran"), "1405-05-25");
  assert.match(url, /\/train\/QUM-THR\?/);
  assert.match(url, /departing=1405-05-25/);
});

test("validates and filters departure times", () => {
  assert.equal(validateTime("۰۶:۳۵"), "06:35");
  assert.equal(timeInRange("06:35", "06:00", "09:00"), true);
  assert.equal(timeInRange("14:45", "06:00", "09:00"), false);
  assert.throws(() => validateTime("25:00"), /HH:MM/);
});

test("matches the selected Telegram departure time exactly", () => {
  const trains = [
    { departure: "06:35", arrival: "09:10", available: false },
    { departure: "14:45", arrival: "17:10", available: true }
  ];
  assert.equal(matchingTrain(trains, "14:45")?.available, true);
  assert.equal(matchingTrain(trains, "14:46"), undefined);
});

test("builds future Jalali month and day options", () => {
  const months = jalaliDateOptions(new Date("2026-08-15T12:00:00Z"));
  assert.equal(months[0].key, "1405-05");
  assert.deepEqual(months[0].days.map((day) => day.day), [24, 25, 26, 27, 28, 29, 30, 31]);
  assert.equal(months[0].days[0].value, "1405-05-24");
  assert.equal(months[1].days.length, 31);
  assert.equal(months.length, 3);
});

test("does not offer dates from the next Jalali year", () => {
  const months = jalaliDateOptions(new Date("2027-03-18T12:00:00Z"));
  assert.ok(months.length > 0);
  assert.ok(months.length <= 3);
  assert.ok(months.every((month) => month.key.startsWith("1405-")));
});

test("uses correct Jalali month lengths", () => {
  for (let month = 1; month <= 6; month++) assert.equal(jalaliMonthLength(1405, month), 31);
  for (let month = 7; month <= 11; month++) assert.equal(jalaliMonthLength(1405, month), 30);
  assert.equal(jalaliMonthLength(1405, 12), 29);
  assert.equal(jalaliMonthLength(1403, 12), 30);
});
