# Train Alert – Telegram Bot

A read-only command-line checker for train availability on Alibaba.ir. It supports
`قم → تهران` and `تهران → قم`, checks a Persian (Jalali) date, and can optionally
send a Telegram message when a purchasable result appears.

## Install

```bash
npm install
npx playwright install chromium
```

If the Playwright download is unavailable in your region, the checker
automatically uses an installed Google Chrome, Microsoft Edge, or Chromium.
You can also set `CHROME_PATH` to a browser executable.

## Run one check

```bash
npm run check -- --date 1405-05-25 --direction qom-tehran
```

Configuration can be placed in a local `.env` file. Copy `.env.example` to
`.env`, enter the secrets there, and keep `.env` private; it is git-ignored.

Watch one exact departure time every two minutes:

```bash
npm run check -- --date 1405-05-25 --direction qom-tehran --time 06:35 --interval 120
```

Or watch a time window:

```bash
npm run check -- --date 1405-05-25 --direction tehran-qom --from-time 17:00 --to-time 21:00 --interval 120
```

The date is Jalali, not Gregorian. Persian digits and `/` are accepted too:

```bash
npm run check -- --date ۱۴۰۵/۰۵/۲۵ --direction tehran-qom
```

## Keep watching

Check every two minutes:

```bash
npm run check -- --date 1405-05-25 --direction qom-tehran --interval 120
```

## Interactive Telegram bot

The bot lets you create a notification without terminal arguments:

1. Send `/start` and choose from the current Jalali month and the next two months.
2. Tap a future day in that month.
3. Tap `از قم به تهران` or `از تهران به قم`.
4. Wait for Alibaba's departure times and tap one.
5. The selection is saved and checked every two minutes.
6. Send `/list` to view or cancel saved notifications.

Start the service and keep it running:

```bash
npm run bot
```

Subscriptions survive restarts in a local git-ignored state file. Set
`CHECK_INTERVAL_SECONDS` in `.env` to change the interval (minimum 60).

If Telegram is blocked on the terminal network and your VPN provides an HTTP
proxy, configure it before starting:

```env
TELEGRAM_PROXY_URL=http://127.0.0.1:7890
```

Use `--headed` if the site shows a CAPTCHA. The program will open a browser and
you can complete the challenge yourself.

## Telegram alerts (optional)

Set the variables in the shell before starting the monitor:

```bash
export TELEGRAM_BOT_TOKEN='token from BotFather'
npm run check -- --date 1405-05-25 --direction qom-tehran --interval 120
```

Set `TELEGRAM_USERNAME` to your Telegram username and the checker discovers the
numeric chat ID automatically. After creating the bot, open it and send `/start` once before
starting the checker. `TELEGRAM_CHAT_ID` is still supported as an optional
override.

The checker alerts once when availability first appears. It can alert again if
the route becomes unavailable and later becomes available again.

## Email alerts with Gmail

By default the alert is emailed to the sender address (`SMTP_USER`); set
`EMAIL_TO` to send it somewhere else. Gmail requires an App Password; do not put your normal Google password in this project.

1. Enable 2-Step Verification on the Google account that will send the email.
2. Create a Google App Password for the monitor.
3. Start the checker with these environment variables:

```bash
export SMTP_USER='your-sender@gmail.com'
export SMTP_PASS='your-16-character-app-password'

npm run check -- \
  --date 1405-05-25 \
  --direction qom-tehran \
  --time 06:35 \
  --interval 120
```

To send to a different address, set `EMAIL_TO`. For another SMTP provider, set
`SMTP_HOST` and `SMTP_PORT` as well. Credentials remain in the shell environment
and are not written to project files.

## Notes

- This tool only searches. It does not log in, reserve seats, bypass CAPTCHA, or buy tickets.
- Availability can change between the check and checkout.
- Alibaba may change its page URL or wording. Run `npm test` after edits.
- Use a respectful interval (60 seconds or more) and comply with the site's terms.

## macOS menu bar app

`macapp/` contains a native SwiftUI menu bar app (**Train Alert**) with the same flow as the Telegram bot: pick a month, a day, a direction and a departure time, then see and manage your active alerts from the menu bar. It calls `src/menubar-cli.js` under the hood.

```bash
npm install
cd macapp && ./build.sh          # builds macapp/build/Train Alert.app
open "build/Train Alert.app"
```

`build.sh` records this project's folder and your `node` path inside the app. If you move the project, rebuild it. Set `NODE_PATH=/path/to/node` before building to use a specific Node.js installation.

## Security

All secrets (`TELEGRAM_BOT_TOKEN`, `SMTP_PASS`, and so on) are read from environment variables or a local `.env` file, which is git-ignored. Only `.env.example`, with empty values, is part of the repository.
