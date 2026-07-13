# Anonymous Telegram Chat Bot

A JavaScript Telegram bot built with [grammY](https://grammy.dev/) for anonymous one-to-one chats. Users complete a profile, search for random partners, spend referral coins on filtered searches, share usernames with `/dm`, and report abusive chats to the developer.

## Features

- `/start` creates an account, assigns a unique internal user id, and collects nickname, age, gender, and sexuality.
- Inline buttons start random partner search, filtered search, show referral coins, or end a chat.
- Filtered search can target gender, age range, and sexuality and costs premium coins.
- New users receive configurable starting coins, and referrers receive coins when friends join from their referral link.
- Messages are copied between paired chats so partners stay anonymous.
- `/dm` shares the sender's Telegram username with the current partner only.
- `/report <reason>` sends both users' profile information plus recent chat messages to the developer id.
- `/stats [search]` is developer-only and shows usage statistics plus searchable user records.
- SQLite stores account details, profile parameters, queues, chats, messages, reports, and coin balances.

## Setup

1. Install Node.js 20+.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` values into your environment and set `BOT_TOKEN` and `DEVELOPER_ID`.
4. Start the bot:

   ```bash
   BOT_TOKEN="123456:token" DEVELOPER_ID="123456789" npm start
   ```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_TOKEN` | required | Telegram bot token from BotFather. |
| `DEVELOPER_ID` | `0` | Telegram user id that can use `/stats` and receives reports. |
| `INITIAL_COINS` | `20` | Coins given to every new user. |
| `FILTER_SEARCH_COST` | `5` | Cost of one filtered search. |
| `REFERRAL_REWARD` | `10` | Coins given to a referrer when a new user joins. |
| `DATABASE_PATH` | `anonymous_chat.sqlite3` | SQLite database file path. |

## Commands

| Command | Who can use it | Purpose |
| --- | --- | --- |
| `/start [referrer_id]` | Everyone | Register, complete profile, or reopen the main menu. |
| `/dm` | Active chat users | Share your Telegram username with the current partner. |
| `/stop` | Everyone | End the current chat or leave the waiting queue. |
| `/report <reason>` | Active chat users | Send the chat and both profiles to the developer. |
| `/stats [search]` | Developer only | View usage totals and recent or matching users. |

## Filtered search format

After tapping **Filtered search**, send filters as:

```text
gender min_age max_age sexuality
```

Example:

```text
female 18 25 straight
```
