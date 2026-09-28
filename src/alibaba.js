import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { buildSearchUrl, timeInRange, toAsciiDigits } from "./availability.js";

function browserExecutable() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean).find(existsSync);
}

export async function launchBrowser() {
  const executablePath = browserExecutable();
  return chromium.launch({
    headless: process.env.HEADED !== "true",
    ...(executablePath ? { executablePath } : {})
  });
}

export async function searchTrains(browser, route, date, timeoutMs = 60_000) {
  const url = buildSearchUrl(route, date);
  const page = await browser.newPage({
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    viewport: { width: 1365, height: 900 }
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await Promise.race([
      page.getByText("اطلاعات قطار", { exact: true }).first().waitFor({ timeout: 30_000 }),
      page.getByText(/(?:قطاری|بلیطی).*(?:یافت|پیدا).*نشد/).first().waitFor({ timeout: 30_000 })
    ]).catch(() => {});
    await page.waitForTimeout(2500);

    const body = await page.locator("body").innerText();
    if (/captcha|کپچا|ربات نیستید|دسترسی شما محدود|access denied/i.test(body)) {
      throw new Error("Alibaba requested CAPTCHA. Run with HEADED=true and complete it manually.");
    }
    if (!page.url().includes(`/train/${route.fromCode}-${route.toCode}`)) {
      throw new Error("Alibaba redirected away from the requested train search.");
    }

    const rawCards = await page.getByText(/^(?:انتخاب بلیط|تکمیل ظرفیت|ناموجود)$/).evaluateAll((labels) => {
      const unique = new Map();
      for (const label of labels) {
        let element = label.parentElement;
        while (element && element !== document.body) {
          const text = element.innerText?.replace(/\s+/g, " ").trim() ?? "";
          const times = [...text.matchAll(/(?:^|\s)([۰-۹0-9]{1,2}:[۰-۹0-9]{2})(?=\s|$)/g)].map((m) => m[1]);
          if (times.length >= 2 && /(?:انتخاب\s*بلیط|تکمیل\s*ظرفیت|ناموجود|صندلی\s*باقی\s*مانده)/.test(text)) {
            const key = `${times[0]}-${times[1]}`;
            if (!unique.has(key)) unique.set(key, { times, text });
            break;
          }
          element = element.parentElement;
        }
      }
      return [...unique.values()];
    });

    const trains = rawCards.map(({ times, text }) => ({
      departure: toAsciiDigits(times[0]).padStart(5, "0"),
      arrival: toAsciiDigits(times[1]).padStart(5, "0"),
      available: /انتخاب\s*بلیط|[۱-۹1-9][۰-۹0-9]*\s*صندلی\s*باقی\s*مانده/.test(text) && !/تکمیل\s*ظرفیت|ناموجود/.test(text),
      details: text
    })).sort((a, b) => a.departure.localeCompare(b.departure));

    return { url, trains };
  } finally {
    await page.close();
  }
}

export function matchingTrain(trains, time) {
  return trains.find((train) => timeInRange(train.departure, time, time));
}
