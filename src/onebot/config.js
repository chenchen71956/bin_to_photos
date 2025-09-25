"use strict";

function parseAdminGroupIds(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[;,\s]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

const WS_URL = process.env.WS_URL;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const ADMIN_GROUP_IDS = parseAdminGroupIds(process.env.ADMIN_GROUP_ID);

module.exports = { WS_URL, ACCESS_TOKEN, ADMIN_GROUP_IDS, parseAdminGroupIds };


