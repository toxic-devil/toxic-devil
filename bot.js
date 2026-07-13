import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { Bot, GrammyError, HttpError, InlineKeyboard, session } from "grammy";

const BOT_TOKEN = process.env.BOT_TOKEN;
const DEVELOPER_ID = Number(process.env.DEVELOPER_ID || 0);
const DATABASE_PATH = process.env.DATABASE_PATH || "anonymous_chat.sqlite3";
const INITIAL_COINS = Number(process.env.INITIAL_COINS || 20);
const FILTER_SEARCH_COST = Number(process.env.FILTER_SEARCH_COST || 5);
const REFERRAL_REWARD = Number(process.env.REFERRAL_REWARD || 10);
const GENDERS = new Set(["male", "female", "other"]);
const SEXUALITIES = new Set(["straight", "gay", "lesbian"]);

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN environment variable is required");
}

const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    unique_id TEXT NOT NULL UNIQUE,
    nickname TEXT,
    age INTEGER,
    gender TEXT,
    sexuality TEXT,
    username TEXT,
    coins INTEGER NOT NULL DEFAULT 0,
    referred_by INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS waiting_queue (
    user_id INTEGER PRIMARY KEY,
    gender_filter TEXT,
    min_age INTEGER,
    max_age INTEGER,
    sexuality_filter TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER NOT NULL,
    user_b INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    reported_by INTEGER,
    report_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    message_type TEXT NOT NULL,
    text TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
  );
`);

const statements = {
  findUser: db.prepare("SELECT * FROM users WHERE user_id = ?"),
  insertUser: db.prepare(`
    INSERT INTO users(user_id, unique_id, username, coins, referred_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  updateUsername: db.prepare("UPDATE users SET username = ?, updated_at = ? WHERE user_id = ?"),
  rewardReferrer: db.prepare("UPDATE users SET coins = coins + ? WHERE user_id = ?"),
  completeProfile: db.prepare(`
    UPDATE users
    SET nickname = ?, age = ?, gender = ?, sexuality = ?, updated_at = ?
    WHERE user_id = ?
  `),
  removeFromQueue: db.prepare("DELETE FROM waiting_queue WHERE user_id = ?"),
  removePairFromQueue: db.prepare("DELETE FROM waiting_queue WHERE user_id IN (?, ?)"),
  waitingCandidates: db.prepare(`
    SELECT q.*, u.nickname, u.age, u.gender, u.sexuality
    FROM waiting_queue q
    JOIN users u ON u.user_id = q.user_id
    WHERE q.user_id != ?
    ORDER BY RANDOM()
  `),
  upsertQueue: db.prepare(`
    INSERT OR REPLACE INTO waiting_queue(user_id, gender_filter, min_age, max_age, sexuality_filter, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  createChat: db.prepare("INSERT INTO chats(user_a, user_b, started_at) VALUES (?, ?, ?)"),
  activeChat: db.prepare(`
    SELECT * FROM chats
    WHERE ended_at IS NULL AND (user_a = ? OR user_b = ?)
    ORDER BY id DESC
    LIMIT 1
  `),
  endChat: db.prepare("UPDATE chats SET ended_at = ? WHERE id = ?"),
  addMessage: db.prepare(`
    INSERT INTO messages(chat_id, sender_id, message_type, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  deductCoins: db.prepare("UPDATE users SET coins = coins - ?, updated_at = ? WHERE user_id = ?"),
  setReport: db.prepare("UPDATE chats SET reported_by = ?, report_reason = ? WHERE id = ?"),
  usersByIds: db.prepare("SELECT * FROM users WHERE user_id IN (?, ?)"),
  recentMessages: db.prepare("SELECT sender_id, text, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 50"),
  totals: db.prepare("SELECT COUNT(*) AS users, COALESCE(SUM(coins), 0) AS coins FROM users"),
  activeCount: db.prepare("SELECT COUNT(*) AS count FROM chats WHERE ended_at IS NULL"),
  waitingCount: db.prepare("SELECT COUNT(*) AS count FROM waiting_queue"),
  recentUsers: db.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT 20"),
  searchUsers: db.prepare(`
    SELECT * FROM users
    WHERE unique_id LIKE ? OR nickname LIKE ? OR username LIKE ? OR CAST(user_id AS TEXT) LIKE ?
    LIMIT 20
  `),
};

const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));

function now() {
  return new Date().toISOString();
}

function uniqueCode() {
  return `U${randomBytes(4).toString("hex").toUpperCase()}`;
}

function mainKeyboard() {
  return new InlineKeyboard()
    .text("🔎 Random partner", "search:random")
    .row()
    .text(`🎯 Filtered search (${FILTER_SEARCH_COST} coins)`, "search:filtered")
    .row()
    .text("💰 Coins & referral", "coins")
    .row()
    .text("⛔ End chat", "end");
}

function ensureUser(from, referrerId = null) {
  const existing = statements.findUser.get(from.id);
  if (existing) {
    statements.updateUsername.run(from.username || null, now(), from.id);
    return existing;
  }

  const referredBy = referrerId && referrerId !== from.id ? referrerId : null;
  statements.insertUser.run(from.id, uniqueCode(), from.username || null, INITIAL_COINS, referredBy, now(), now());
  if (referredBy) {
    statements.rewardReferrer.run(REFERRAL_REWARD, referredBy);
  }
  return statements.findUser.get(from.id);
}

function isCompleteProfile(user) {
  return Boolean(user?.nickname && user?.age && user?.gender && user?.sexuality);
}

function partnerFor(chat, userId) {
  return chat.user_a === userId ? chat.user_b : chat.user_a;
}

function getActiveChat(userId) {
  return statements.activeChat.get(userId, userId);
}

function waitingUserAccepts(waitingRow, seeker) {
  if (waitingRow.gender_filter && seeker.gender !== waitingRow.gender_filter) return false;
  if (waitingRow.sexuality_filter && seeker.sexuality !== waitingRow.sexuality_filter) return false;
  if (waitingRow.min_age && seeker.age < waitingRow.min_age) return false;
  if (waitingRow.max_age && seeker.age > waitingRow.max_age) return false;
  return true;
}

function seekerAccepts(row, criteria) {
  if (criteria.gender && row.gender !== criteria.gender) return false;
  if (criteria.sexuality && row.sexuality !== criteria.sexuality) return false;
  if (criteria.minAge && row.age < criteria.minAge) return false;
  if (criteria.maxAge && row.age > criteria.maxAge) return false;
  return true;
}

function findOrQueueMatch(userId, criteria = {}) {
  const seeker = statements.findUser.get(userId);
  const candidates = statements.waitingCandidates.all(userId);

  for (const row of candidates) {
    if (!seekerAccepts(row, criteria) || !waitingUserAccepts(row, seeker)) continue;
    const result = db.transaction(() => {
      statements.removePairFromQueue.run(userId, row.user_id);
      const chat = statements.createChat.run(userId, row.user_id, now());
      return chat.lastInsertRowid;
    })();
    return { partnerId: row.user_id, chatId: result };
  }

  statements.upsertQueue.run(userId, criteria.gender || null, criteria.minAge || null, criteria.maxAge || null, criteria.sexuality || null, now());
  return null;
}

function extractMessageText(message) {
  return message.text || message.caption || `[${message.animation ? "animation" : message.photo ? "photo" : message.video ? "video" : message.document ? "document" : "message"}]`;
}

function formatUser(user) {
  return `${user.unique_id} tg:${user.user_id} @${user.username || "-"} ${user.nickname || "-"}, ${user.age || "-"}, ${user.gender || "-"}, ${user.sexuality || "-"}, coins:${user.coins}`;
}

async function handleProfileStep(ctx) {
  const step = ctx.session.profileStep;
  if (!step || !ctx.message?.text) return false;

  const text = ctx.message.text.trim();
  if (step === "nickname") {
    ctx.session.profile = { nickname: text };
    ctx.session.profileStep = "age";
    await ctx.reply("Now send your age.");
    return true;
  }

  if (step === "age") {
    const age = Number(text);
    if (!Number.isInteger(age) || age < 13 || age > 99) {
      await ctx.reply("Age must be a number between 13 and 99.");
      return true;
    }
    ctx.session.profile.age = age;
    ctx.session.profileStep = "gender";
    await ctx.reply("Send your gender: male, female, or other.");
    return true;
  }

  if (step === "gender") {
    const gender = text.toLowerCase();
    if (!GENDERS.has(gender)) {
      await ctx.reply("Send gender: male, female, or other.");
      return true;
    }
    ctx.session.profile.gender = gender;
    ctx.session.profileStep = "sexuality";
    await ctx.reply("Send sexuality: straight, gay, or lesbian.");
    return true;
  }

  if (step === "sexuality") {
    const sexuality = text.toLowerCase();
    if (!SEXUALITIES.has(sexuality)) {
      await ctx.reply("Send sexuality: straight, gay, or lesbian.");
      return true;
    }
    const profile = { ...ctx.session.profile, sexuality };
    statements.completeProfile.run(profile.nickname, profile.age, profile.gender, profile.sexuality, now(), ctx.from.id);
    ctx.session.profile = null;
    ctx.session.profileStep = null;
    await ctx.reply(`Profile complete! You received ${INITIAL_COINS} starting coins.`, { reply_markup: mainKeyboard() });
    return true;
  }

  return false;
}

async function handleFilterStep(ctx) {
  if (!ctx.session.awaitingFilter || !ctx.message?.text) return false;
  const [gender, minAgeRaw, maxAgeRaw, sexuality] = ctx.message.text.trim().toLowerCase().split(/\s+/);
  const minAge = Number(minAgeRaw);
  const maxAge = Number(maxAgeRaw);
  if (!GENDERS.has(gender) || !SEXUALITIES.has(sexuality) || !Number.isInteger(minAge) || !Number.isInteger(maxAge) || minAge > maxAge) {
    await ctx.reply("Invalid format. Example: female 18 25 straight");
    return true;
  }

  const user = statements.findUser.get(ctx.from.id);
  if (user.coins < FILTER_SEARCH_COST) {
    ctx.session.awaitingFilter = false;
    await ctx.reply("Not enough coins. Invite friends to earn more.", { reply_markup: mainKeyboard() });
    return true;
  }

  statements.deductCoins.run(FILTER_SEARCH_COST, now(), ctx.from.id);
  ctx.session.awaitingFilter = false;
  await startSearch(ctx, { gender, minAge, maxAge, sexuality });
  return true;
}

async function beginProfile(ctx) {
  ctx.session.profile = {};
  ctx.session.profileStep = "nickname";
  await ctx.reply("Welcome to anonymous chat. Send your nickname.");
}

async function requireProfile(ctx) {
  const user = ensureUser(ctx.from);
  if (isCompleteProfile(user)) return true;
  await beginProfile(ctx);
  return false;
}

async function startSearch(ctx, criteria = {}) {
  const userId = ctx.from.id;
  if (getActiveChat(userId)) {
    await ctx.reply("You are already in a chat. Use /stop to end it first.");
    return;
  }

  const match = findOrQueueMatch(userId, criteria);
  if (!match) {
    await ctx.reply("Searching... You will be connected when a matching partner appears.");
    return;
  }

  const text = "Partner found! Say hi anonymously. Use /stop to end, /dm to share username, /report <reason> to report.";
  await ctx.reply(text);
  await ctx.api.sendMessage(match.partnerId, text);
}

bot.command("start", async (ctx) => {
  const referrer = Number(ctx.match?.trim());
  const user = ensureUser(ctx.from, Number.isInteger(referrer) ? referrer : null);
  if (!isCompleteProfile(user)) {
    await beginProfile(ctx);
    return;
  }
  await ctx.reply("Welcome back! Use the buttons below to find a partner.", { reply_markup: mainKeyboard() });
});

bot.callbackQuery("search:random", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (await requireProfile(ctx)) await startSearch(ctx);
});

bot.callbackQuery("search:filtered", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (await requireProfile(ctx)) {
    ctx.session.awaitingFilter = true;
    await ctx.reply("Send filters as: gender min_age max_age sexuality\nExample: female 18 25 straight");
  }
});

bot.callbackQuery("coins", async (ctx) => {
  await ctx.answerCallbackQuery();
  const user = ensureUser(ctx.from);
  const me = await ctx.api.getMe();
  await ctx.reply(`Coins: ${user.coins}\nReferral link: https://t.me/${me.username}?start=${ctx.from.id}`, { reply_markup: mainKeyboard() });
});

bot.callbackQuery("end", async (ctx) => {
  await ctx.answerCallbackQuery();
  await stopChatOrQueue(ctx, "Chat ended.");
});

bot.command("stop", async (ctx) => {
  await stopChatOrQueue(ctx, "Stopped searching/chatting.");
});

async function stopChatOrQueue(ctx, text) {
  const chat = getActiveChat(ctx.from.id);
  statements.removeFromQueue.run(ctx.from.id);
  if (chat) {
    statements.endChat.run(now(), chat.id);
    await ctx.api.sendMessage(partnerFor(chat, ctx.from.id), "Your partner left the chat.");
  }
  await ctx.reply(text, { reply_markup: mainKeyboard() });
}

bot.command("dm", async (ctx) => {
  const user = statements.findUser.get(ctx.from.id);
  const chat = getActiveChat(ctx.from.id);
  if (!chat || !isCompleteProfile(user)) {
    await ctx.reply("You must be in a chat to share your username.");
    return;
  }
  if (!user.username) {
    await ctx.reply("Set a Telegram username first, then use /dm again.");
    return;
  }
  await ctx.api.sendMessage(partnerFor(chat, ctx.from.id), `Your partner shared their username: @${user.username}`);
  await ctx.reply("Username shared.");
});

bot.command("report", async (ctx) => {
  const chat = getActiveChat(ctx.from.id);
  if (!chat) {
    await ctx.reply("You are not in an active chat to report.");
    return;
  }

  const reason = ctx.match?.trim() || "No reason provided";
  const otherId = partnerFor(chat, ctx.from.id);
  statements.setReport.run(ctx.from.id, reason, chat.id);
  const users = statements.usersByIds.all(ctx.from.id, otherId).map(formatUser);
  const messages = statements.recentMessages.all(chat.id).reverse().map((message) => `[${message.created_at}] ${message.sender_id}: ${message.text}`);
  const report = [`🚨 Report #${chat.id}`, `Reason: ${reason}`, "", "Users:", ...users, "", "Recent messages:", ...messages].join("\n");

  if (DEVELOPER_ID) await ctx.api.sendMessage(DEVELOPER_ID, report.slice(0, 4000));
  await ctx.reply("Report sent to the developer.");
});

bot.command("stats", async (ctx) => {
  if (ctx.from.id !== DEVELOPER_ID) return;
  const term = ctx.match?.trim();
  const totals = statements.totals.get();
  const active = statements.activeCount.get().count;
  const waiting = statements.waitingCount.get().count;
  const users = term
    ? statements.searchUsers.all(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`)
    : statements.recentUsers.all();
  const lines = [
    `📊 Users: ${totals.users} | Active chats: ${active} | Waiting: ${waiting} | Total coins: ${totals.coins}`,
    "Recent/search users:",
    ...users.map(formatUser),
  ];
  await ctx.reply(lines.join("\n").slice(0, 4000));
});

bot.on("message", async (ctx) => {
  ensureUser(ctx.from);
  if (await handleProfileStep(ctx)) return;
  if (await handleFilterStep(ctx)) return;
  const chat = getActiveChat(ctx.from.id);
  if (!chat) {
    await ctx.reply("You are not connected. Use /start and tap search.", { reply_markup: mainKeyboard() });
    return;
  }
  const partnerId = partnerFor(chat, ctx.from.id);
  statements.addMessage.run(chat.id, ctx.from.id, ctx.message?.text ? "text" : "message", extractMessageText(ctx.message), now());
  await ctx.copyMessage(partnerId);
});

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error while handling update ${ctx.update.update_id}:`);
  if (err.error instanceof GrammyError) console.error("Error in request:", err.error.description);
  else if (err.error instanceof HttpError) console.error("Could not contact Telegram:", err.error);
  else console.error("Unknown error:", err.error);
});

bot.start();
