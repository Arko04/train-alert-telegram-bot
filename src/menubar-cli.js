#!/usr/bin/env node
// CLI used by the "Train Alert" macOS menu bar app. Talks to Alibaba.ir
// directly (no Telegram, no proxy) and prints a single JSON line per
// invocation so a Swift process can parse it. Independent from bot.js:
// uses its own state file so the Telegram bot is unaffected.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchBrowser, matchingTrain, searchTrains } from "./alibaba.js";
import {
  getCurrentJalaliDateTime,
  jalaliDateOptions,
  parseDirection,
  validateJalaliDate
} from "./availability.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "..", ".menubar-state.json");

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

function ok(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...data })}\n`);
}

function fail(error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
  process.exitCode = 1;
}

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function describe(item) {
  const route = parseDirection(item.direction);
  return { ...item, from: route.from, to: route.to };
}

async function cmdMonths() {
  ok({ months: jalaliDateOptions() });
}

async function cmdSearch(args) {
  const date = validateJalaliDate(args.date);
  const route = parseDirection(args.direction);
  const browser = await launchBrowser();
  try {
    const result = await searchTrains(browser, route, date);
    const currentDateTime = getCurrentJalaliDateTime();
    const trains = result.trains.filter((train) => `${date} ${train.departure}` >= currentDateTime);
    ok({ url: result.url, from: route.from, to: route.to, date, trains });
  } finally {
    await browser.close();
  }
}

async function cmdSubscribe(args) {
  const date = validateJalaliDate(args.date);
  const route = parseDirection(args.direction);
  const time = args.time;
  const existing = state.subscriptions.find((item) =>
    item.date === date && item.direction === args.direction && item.time === time
  );
  if (existing) return ok({ item: describe(existing), created: false });
  const item = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    date,
    direction: args.direction,
    time,
    alerted: args.alerted === "true"
  };
  state.subscriptions.push(item);
  saveState();
  ok({ item: describe(item), created: true, from: route.from, to: route.to });
}

async function cmdList() {
  ok({ subscriptions: state.subscriptions.map(describe) });
}

async function cmdUnsubscribe(args) {
  const index = state.subscriptions.findIndex((item) => item.id === args.id);
  if (index >= 0) state.subscriptions.splice(index, 1);
  saveState();
  ok({ removed: index >= 0 });
}

async function cmdCheck() {
  const currentDateTime = getCurrentJalaliDateTime();
  const expired = [];
  const remaining = [];
  for (const item of state.subscriptions) {
    if (`${item.date} ${item.time}` < currentDateTime) expired.push(describe(item));
    else remaining.push(item);
  }
  if (expired.length) {
    state.subscriptions = remaining;
    saveState();
  }

  const groups = new Map();
  for (const item of state.subscriptions) {
    const key = `${item.direction}:${item.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const newlyAvailable = [];
  const becameUnavailable = [];
  const errors = [];
  let changed = false;
  let browser;
  if (groups.size) browser = await launchBrowser();
  try {
    for (const items of groups.values()) {
      const sample = items[0];
      try {
        const route = parseDirection(sample.direction);
        const result = await searchTrains(browser, route, sample.date);
        for (const item of items) {
          const train = matchingTrain(result.trains, item.time);
          const available = Boolean(train?.available);
          if (available && !item.alerted) {
            item.alerted = true;
            changed = true;
            newlyAvailable.push({ ...describe(item), arrival: train.arrival, url: result.url });
          } else if (!available && item.alerted) {
            item.alerted = false;
            changed = true;
            becameUnavailable.push(describe(item));
          }
        }
      } catch (error) {
        errors.push({ direction: sample.direction, date: sample.date, message: error.message });
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  if (changed) saveState();
  ok({ newlyAvailable, becameUnavailable, expired, errors });
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = readArgs(rest);
  const handlers = {
    months: cmdMonths,
    search: cmdSearch,
    subscribe: cmdSubscribe,
    list: cmdList,
    unsubscribe: cmdUnsubscribe,
    check: cmdCheck
  };
  const handler = handlers[command];
  if (!handler) return fail(new Error(`Unknown command: ${command}. Use one of ${Object.keys(handlers).join(", ")}`));
  await handler(args);
}

main().catch(fail);
