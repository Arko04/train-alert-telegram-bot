#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { launchBrowser, matchingTrain, searchTrains } from "./alibaba.js";
import { jalaliDateOptions, parseDirection, validateJalaliDate, getCurrentJalaliDateTime } from "./availability.js";

const STATE_FILE = ".train-alert-bot-state.json";
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing from .env");

const proxy = process.env.TELEGRAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const sessions = new Map();
let browser;
let polling = true;

function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { subscriptions: Array.isArray(state.subscriptions) ? state.subscriptions : [] };
  } catch {
    return { subscriptions: [] };
  }
}

const state = loadState();
const saveState = () => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

async function apiOnce(method, body = {}) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const longPoll = method === "getUpdates";
  const args = [
    "--silent", "--show-error", "--fail-with-body",
    "--connect-timeout", "5", "--max-time", longPoll ? "40" : "15",
    "--header", "content-type: application/json",
    "--data-binary", "@-"
  ];
  if (proxy) args.push("--proxy", proxy);
  args.push(url);
  const output = await new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `curl exited with code ${code}`));
    });
    child.stdin.end(JSON.stringify(body));
  });
  const payload = JSON.parse(output);
  if (!payload.ok) throw new Error(payload.description || "Telegram API failed");
  return payload.result;
}

async function api(method, body = {}) {
  const attempts = method === "getUpdates" ? 1 : method === "sendMessage" ? 20 : 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await apiOnce(method, body);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

const send = (chatId, text, extra = {}) => api("sendMessage", { chat_id: chatId, text, ...extra });
const answerCallback = (id, text) => api("answerCallbackQuery", { callback_query_id: id, text });
// Acknowledgement is cosmetic and doubles Telegram traffic. With an unstable
// VPN, prioritize the useful next menu instead.
const acknowledge = () => {};

function directionKeyboard() {
  return { inline_keyboard: [
    [{ text: "از قم به تهران", callback_data: "direction:qom-tehran" }],
    [{ text: "از تهران به قم", callback_data: "direction:tehran-qom" }]
  ] };
}

function monthKeyboard() {
  const buttons = jalaliDateOptions().map((month) => ({
    text: month.label,
    callback_data: `month:${month.key}`
  }));
  return { inline_keyboard: buttons.map((button) => [button]) };
}

function dayKeyboard(monthKey) {
  const month = jalaliDateOptions().find((item) => item.key === monthKey);
  if (!month) return null;
  const buttons = month.days.map((day) => ({ text: String(day.day), callback_data: `date:${day.value}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 7) rows.push(buttons.slice(i, i + 7));
  rows.push([{ text: "بازگشت به ماه‌ها", callback_data: "months" }]);
  return { inline_keyboard: rows };
}

function timeKeyboard(trains) {
  const buttons = trains.map((train) => ({
    text: `${train.departure} ${train.available ? "✅" : "⏳"}`,
    callback_data: `time:${train.departure}`
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "شروع دوباره", callback_data: "restart" }]);
  return { inline_keyboard: rows };
}

function subscriptionKeyboard(items) {
  return { inline_keyboard: items.map((item) => [{
    text: `حذف ${item.date}، ${item.time}`,
    callback_data: `delete:${item.id}`
  }]) };
}

async function begin(chatId) {
  sessions.set(String(chatId), { step: "month" });
  await send(chatId, "ماه سفر را انتخاب کنید:", { reply_markup: monthKeyboard() });
}

async function showSubscriptions(chatId) {
  const items = state.subscriptions.filter((item) => String(item.chatId) === String(chatId));
  if (!items.length) return send(chatId, "هنوز هیچ قطاری را دنبال نمی‌کنید. برای شروع /start را بفرستید.");
  const lines = items.map((item, index) => {
    const route = parseDirection(item.direction);
    return `${index + 1}. از ${route.from} به ${route.to} | ${item.date} | ${item.time}`;
  });
  await send(chatId, `قطارهای تحت نظر:\n\n${lines.join("\n")}`, { reply_markup: subscriptionKeyboard(items) });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) return;
  if (text === "/start" || text === "/new") return begin(chatId);
  if (text === "/list") return showSubscriptions(chatId);
  if (text === "/help") return send(chatId, "/start ساخت هشدار جدید\n/list مشاهده و حذف هشدارها");

  const session = sessions.get(String(chatId));
  if (!session || !["month", "date"].includes(session.step)) {
    return send(chatId, "برای ساخت هشدار جدید /start را بفرستید.");
  }
  try {
    session.date = validateJalaliDate(text);
    session.step = "direction";
    await send(chatId, `تاریخ ${session.date} ثبت شد. مسیر را انتخاب کنید:`, { reply_markup: directionKeyboard() });
  } catch (error) {
    await send(chatId, `تاریخ معتبر نیست. ${error.message}\nمثال: 1405-05-25`);
  }
}

async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const key = String(chatId);
  const data = query.data;
  if (data === "restart") {
    acknowledge(query.id, "شروع دوباره");
    return begin(chatId);
  }
  if (data === "months") {
    sessions.set(key, { step: "month" });
    acknowledge(query.id, "انتخاب ماه");
    return send(chatId, "ماه سفر را انتخاب کنید:", { reply_markup: monthKeyboard() });
  }
  if (data.startsWith("delete:")) {
    const id = data.slice(7);
    const index = state.subscriptions.findIndex((item) => item.id === id && String(item.chatId) === key);
    if (index >= 0) state.subscriptions.splice(index, 1);
    saveState();
    acknowledge(query.id, index >= 0 ? "حذف شد" : "پیدا نشد");
    return showSubscriptions(chatId);
  }

  const session = sessions.get(key);
  if (!session) {
    acknowledge(query.id, "این منو منقضی شده است");
    return begin(chatId);
  }
  if (data.startsWith("month:")) {
    const monthKey = data.slice(6);
    const keyboard = dayKeyboard(monthKey);
    if (!keyboard) return answerCallback(query.id, "این ماه دیگر قابل انتخاب نیست");
    session.step = "date";
    session.month = monthKey;
    acknowledge(query.id, "روز را انتخاب کنید");
    return send(chatId, "روز سفر را انتخاب کنید:", { reply_markup: keyboard });
  }
  if (data.startsWith("date:")) {
    try {
      session.date = validateJalaliDate(data.slice(5));
      session.step = "direction";
      acknowledge(query.id, "تاریخ ثبت شد");
      return send(chatId, `تاریخ ${session.date} ثبت شد. مسیر را انتخاب کنید:`, { reply_markup: directionKeyboard() });
    } catch (error) {
      acknowledge(query.id, "تاریخ نامعتبر است");
      return begin(chatId);
    }
  }
  if (data.startsWith("direction:")) {
    const direction = data.slice(10);
    try {
      const route = parseDirection(direction);
      session.direction = direction;
      session.step = "loading";
      acknowledge(query.id, "در حال دریافت ساعت‌ها…");
      console.log(`Selected direction for chat ${chatId}: ${direction} (${route.from} to ${route.to})`);
      await send(chatId, `در حال جستجوی قطارها از ${route.from} به ${route.to}…`);
      const result = await searchTrains(browser, route, session.date);
      const currentDateTime = getCurrentJalaliDateTime();
      const futureTrains = result.trains.filter(train => {
        return `${session.date} ${train.departure}` >= currentDateTime;
      });

      if (!futureTrains.length) {
        session.step = "direction";
        return send(chatId, "برای این تاریخ قطاری که هنوز حرکت نکرده باشد یافت نشد. تاریخ یا مسیر دیگری انتخاب کنید.", { reply_markup: directionKeyboard() });
      }
      session.trains = futureTrains;
      session.url = result.url;
      session.step = "time";
      await send(chatId, "ساعت حرکت را انتخاب کنید. ✅ یعنی اکنون موجود است و ⏳ یعنی برای خالی‌شدن زیر نظر گرفته می‌شود:", {
        reply_markup: timeKeyboard(futureTrains)
      });
    } catch (error) {
      session.step = "direction";
      await send(chatId, `دریافت ساعت‌ها ناموفق بود: ${error.message}`, { reply_markup: directionKeyboard() });
    }
    return;
  }
  if (data.startsWith("time:") && session.step === "time") {
    const time = data.slice(5);
    const train = matchingTrain(session.trains, time);
    if (!train) return answerCallback(query.id, "این ساعت دیگر در فهرست نیست");
    const existing = state.subscriptions.find((item) =>
      String(item.chatId) === key && item.date === session.date &&
      item.direction === session.direction && item.time === time
    );
    if (!existing) {
      state.subscriptions.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        chatId,
        date: session.date,
        direction: session.direction,
        time,
        alerted: train.available
      });
      saveState();
    }
    acknowledge(query.id, existing ? "قبلاً ثبت شده" : "ثبت شد");
    const status = train.available
      ? `این قطار همین حالا صندلی خالی دارد:\n${session.url}`
      : "هشدار ثبت شد. به محض خالی‌شدن صندلی به شما پیام می‌دهم.";
    sessions.delete(key);
    await send(chatId, `✅ ${session.date}، ساعت ${time}\n${status}\n\n/list برای مشاهده هشدارها`);
  }
}

async function checkSubscriptions() {
  const currentDateTime = getCurrentJalaliDateTime();
  let changed = false;
  const activeSubscriptions = [];

  for (const item of state.subscriptions) {
    const itemDateTime = `${item.date} ${item.time}`;
    if (itemDateTime < currentDateTime) {
      const route = parseDirection(item.direction);
      await send(item.chatId, `زمان قطار ${item.date} ساعت ${item.time} از ${route.from} به ${route.to} گذشته است و از لیست شما حذف شد.`).catch(console.error);
      changed = true;
    } else {
      activeSubscriptions.push(item);
    }
  }

  if (changed) {
    state.subscriptions = activeSubscriptions;
    saveState();
  }

  const groups = new Map();
  for (const item of state.subscriptions) {
    const key = `${item.direction}:${item.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  
  for (const items of groups.values()) {
    const sample = items[0];
    try {
      const route = parseDirection(sample.direction);
      const result = await searchTrains(browser, route, sample.date);
      for (const item of items) {
        const train = matchingTrain(result.trains, item.time);
        const available = Boolean(train?.available);
        if (available && !item.alerted) {
          await send(item.chatId, `🚨 صندلی قطار خالی شد!\n\nاز ${route.from} به ${route.to}\nتاریخ: ${item.date}\nحرکت: ${item.time}\nورود: ${train.arrival}\n\nبرای خرید:\n${result.url}`);
          item.alerted = true;
          changed = true;
        } else if (!available && item.alerted) {
          item.alerted = false;
          changed = true;
        }
      }
    } catch (error) {
      console.error(`Subscription check failed for ${sample.direction} ${sample.date}: ${error.message}`);
    }
  }
  if (changed) saveState();
}

async function poll() {
  let offset = 0;
  let firstBatch = true;
  while (polling) {
    try {
      const updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      let updatesToHandle = updates;
      if (firstBatch && updates.length > 1) {
        const latestByChat = new Map();
        for (const update of updates) {
          const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
          if (chatId !== undefined) latestByChat.set(String(chatId), update);
        }
        updatesToHandle = [...latestByChat.values()].sort((a, b) => a.update_id - b.update_id);
      }
      if (updates.length) offset = updates.at(-1).update_id + 1;
      firstBatch = false;
      for (const update of updatesToHandle) {
        console.log(`Received Telegram update ${update.update_id}: ${update.message ? "message" : "callback"}`);
        try {
          if (update.message) await handleMessage(update.message);
          if (update.callback_query) await handleCallback(update.callback_query);
        } catch (error) {
          console.error(`Update failed: ${error.message}`);
        }
      }
    } catch (error) {
      console.error(`Telegram polling failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function main() {
  browser = await launchBrowser();
  let me;
  while (!me) {
    try {
      me = await api("getMe");
    } catch (error) {
      console.error(`Waiting for Telegram/Hiddify: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  console.log(`@${me.username} is running with ${state.subscriptions.length} saved subscription(s).`);
  await api("setMyCommands", { commands: [
    { command: "start", description: "ساخت هشدار جدید" },
    { command: "list", description: "مشاهده و حذف هشدارها" },
    { command: "help", description: "راهنما" }
  ] }).catch((error) => console.error(`Could not update bot commands: ${error.message}`));
  const intervalMs = Math.max(60, Number(process.env.CHECK_INTERVAL_SECONDS || 120)) * 1000;
  const timer = setInterval(() => checkSubscriptions().catch(console.error), intervalMs);
  await checkSubscriptions();
  const shutdown = async () => {
    polling = false;
    clearInterval(timer);
    await browser.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await poll();
}

main().catch(async (error) => {
  console.error(`Bot failed: ${error.message}`);
  if (browser) await browser.close();
  process.exitCode = 1;
});
