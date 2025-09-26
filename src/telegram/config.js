"use strict";

function parseIds(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw.split(/[;,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_IDS = parseIds(process.env.TELEGRAM_CHAT_ID);

module.exports = { TG_BOT_TOKEN, TG_CHAT_IDS };


