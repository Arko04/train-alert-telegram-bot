#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { chromium } from "playwright";
import {
  buildSearchUrl,
  classifyPageText,
  parseDirection,
  timeInRange,
  validateTime,
  validateJalaliDate
} from "./availability.js";

function usage() {
  console.log(`Usage:
  npm run check -- --date 1405-05-25 [--direction qom-tehran]

Options:
  --date         Persian/Jalali date (required)
  --direction    qom-tehran (default) or tehran-qom
  --time         Exact departure time, for example 06:35
  --from-time    Start of departure window, for example 06:00
  --to-time      End of departure window, for example 09:00
  --interval     Repeat every N seconds (minimum 60); omit for one check
  --headed       Show the browser window (useful if Alibaba asks for CAPTCHA)
  --timeout      Page timeout in seconds (default 45)
  --help         Show this help

Optional Telegram environment variables:
  TELEGRAM_BOT_TOKEN (required); TELEGRAM_CHAT_ID is auto-discovered when omitted

Email environment variables:
  SMTP_USER and SMTP_PASS (Gmail App Password)
  EMAIL_TO (optional) defaults to SMTP_USER, i.e. alerts are sent to yourself
`);
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--headed" || item === "--help") result[item.slice(2)] = true;
    else if (item.startsWith("--")) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${item}`);
      result[item.slice(2)] = argv[++i];
    } else throw new Error(`Unknown argument: ${item}`);
  }
  return result;
}

async function telegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const chatId = process.env.TELEGRAM_CHAT_ID || await discoverTelegramChatId(token);
  if (!chatId) {
    throw new Error("Could not find your Telegram chat. Open your new bot, press Start, send /start, and run the checker again.");
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true })
  });
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
  return true;
}

async function discoverTelegramChatId(token) {
  const username = (process.env.TELEGRAM_USERNAME || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (!username) return undefined;
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  if (!response.ok) throw new Error(`Telegram getUpdates returned HTTP ${response.status}`);
  const payload = await response.json();
  const messages = (payload.result || []).flatMap((update) =>
    [update.message, update.edited_message, update.channel_post].filter(Boolean)
  );
  return messages.reverse().find((item) =>
    item.from?.username?.toLowerCase() === username
  )?.chat?.id;
}

async function emailAlert({ route, date, trains, url }) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return false;

  const to = process.env.EMAIL_TO || user;
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
  const trainLines = trains.map((train) =>
    `${train.departure} → ${train.arrival}\n${train.details}`
  ).join("\n\n");

  await transporter.sendMail({
    from: `Train Alert <${user}>`,
    to,
    subject: `Train seat available: ${route.from} → ${route.to}, ${date}`,
    text: `A matching train seat is available.\n\nRoute: ${route.from} → ${route.to}\nDate: ${date}\n\n${trainLines}\n\nOpen Alibaba to buy it yourself:\n${url}\n\nAvailability may change quickly.`
  });
  return true;
}

async function inspectPage(page, url, timeoutMs, fromTime, toTime) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 20_000) }).catch(() => {});
  await page.waitForTimeout(2500);

  const title = await page.title();
  const body = await page.locator("body").innerText({ timeout: 10_000 });
  const blocked = /captcha|کپچا|ربات نیستید|دسترسی شما محدود|access denied/i.test(`${title} ${body}`);
  if (blocked) throw new Error("Alibaba blocked the automated page or requested CAPTCHA. Re-run with --headed and complete it manually.");

  const status = classifyPageText(body);
  const trains = await page.getByText("انتخاب بلیط", { exact: true }).evaluateAll((actions) => actions.map((action) => {
    let element = action.parentElement;
    while (element && element !== document.body) {
      const text = element.innerText?.replace(/\s+/g, " ").trim() ?? "";
      const times = [...text.matchAll(/(?:^|\s)([۰-۹0-9]{1,2}:[۰-۹0-9]{2})(?=\s|$)/g)].map((m) => m[1]);
      if (times.length >= 2 && /صندلی\s*باقی\s*مانده/.test(text)) return { text, times };
      element = element.parentElement;
    }
    return null;
  }).filter(Boolean)).catch(() => []);
  const normalizedTrains = trains.map((train) => ({
    departure: train.times[0].replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).padStart(5, "0"),
    arrival: train.times[1].replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).padStart(5, "0"),
    details: train.text
  })).filter((train) => timeInRange(train.departure, fromTime, toTime));
  const usefulLines = body.split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:تومان|ریال|ظرفیت|انتخاب|خرید|ناموجود|حرکت|ورود|\d{1,2}:\d{2}|[۰-۹]{1,2}:[۰-۹]{2})/.test(line))
    .slice(0, 30);
  return { ...status, available: normalizedTrains.length > 0, trains: normalizedTrains, title, usefulLines };
}

function readAlertState() {
  try { return JSON.parse(readFileSync(".train-alert-state.json", "utf8")); }
  catch { return {}; }
}

function saveAlertState(state) {
  writeFileSync(".train-alert-state.json", `${JSON.stringify(state, null, 2)}\n`);
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.help) return usage();
  if (!options.date) throw new Error("--date is required. Use --help for an example.");

  const date = validateJalaliDate(options.date);
  const route = parseDirection(options.direction);
  const interval = options.interval === undefined ? 0 : Number(options.interval);
  const exactTime = options.time ? validateTime(options.time, "--time") : null;
  const fromTime = exactTime ?? (options["from-time"] ? validateTime(options["from-time"], "--from-time") : "00:00");
  const toTime = exactTime ?? (options["to-time"] ? validateTime(options["to-time"], "--to-time") : "23:59");
  if (fromTime > toTime) throw new Error("--from-time cannot be later than --to-time");
  const timeoutMs = Number(options.timeout ?? 45) * 1000;
  if (!Number.isFinite(interval) || (interval > 0 && interval < 60)) throw new Error("--interval must be at least 60 seconds");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5000) throw new Error("--timeout must be at least 5 seconds");

  const url = buildSearchUrl(route, date);
  const chromePaths = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  const executablePath = chromePaths.find(existsSync);
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(executablePath ? { executablePath } : {})
  });
  const context = await browser.newContext({
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    viewport: { width: 1365, height: 900 }
  });
  const page = await context.newPage();
  const stateKey = `${route.fromCode}-${route.toCode}:${date}:${fromTime}-${toTime}`;
  const alertState = readAlertState();
  let alerted = alertState[stateKey] === true;

  try {
    do {
      const now = new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Tehran" }).format(new Date());
      try {
        const result = await inspectPage(page, url, timeoutMs, fromTime, toTime);
        const state = result.available ? "AVAILABLE" : result.soldOut ? "SOLD OUT / NO RESULT" : "UNKNOWN";
        console.log(`[${now}] ${route.from} → ${route.to}, ${date}: ${state}`);
        console.log(`Departure filter: ${fromTime}${fromTime === toTime ? "" : `–${toTime}`}`);
        for (const train of result.trains) console.log(`  ${train.departure} → ${train.arrival}: ${train.details}`);
        console.log(url);

        if (result.available && !alerted) {
          const list = result.trains.map((train) => `${train.departure} → ${train.arrival}`).join("\n");
          const message = `بلیط قطار موجود شد\n${route.from} → ${route.to}\nتاریخ: ${date}\n${list}\n${url}`;
          const deliveryResults = await Promise.allSettled([
            telegram(message),
            emailAlert({ route, date, trains: result.trains, url })
          ]);
          const telegramSent = deliveryResults[0].status === "fulfilled" && deliveryResults[0].value;
          const emailSent = deliveryResults[1].status === "fulfilled" && deliveryResults[1].value;
          if (telegramSent) console.log("Telegram alert sent.");
          if (emailSent) console.log(`Email alert sent to ${process.env.EMAIL_TO || process.env.SMTP_USER}.`);
          for (const delivery of deliveryResults) {
            if (delivery.status === "rejected") console.error(`Notification failed: ${delivery.reason.message}`);
          }
          const sent = telegramSent || emailSent;
          if (!sent) console.log("Seat found, but no remote alert was sent. Configure SMTP_USER and SMTP_PASS for email.");
          alerted = true;
          if (sent) {
            alertState[stateKey] = true;
            saveAlertState(alertState);
          }
        } else if (!result.available && alerted) {
          alerted = false;
          alertState[stateKey] = false;
          saveAlertState(alertState);
        }
      } catch (error) {
        console.error(`[${now}] Check failed: ${error.message}`);
      }
      if (interval > 0) await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    } while (interval > 0);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
