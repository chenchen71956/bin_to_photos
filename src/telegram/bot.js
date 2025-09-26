"use strict";

const https = require("https");
const { TG_BOT_TOKEN, TG_CHAT_IDS } = require("./config");

let proxyAgentFactory = null;
try { proxyAgentFactory = require("https-proxy-agent"); } catch {}
let socksAgentFactory = null;
try { socksAgentFactory = require("socks-proxy-agent"); } catch {}

function buildAgentFromEnv() {
  const proxyUrl = process.env.TELEGRAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxyUrl || typeof proxyUrl !== "string") return null;
  try {
    if (/^socks/i.test(proxyUrl) && socksAgentFactory) {
      const agent = new socksAgentFactory.SocksProxyAgent(proxyUrl);
      agent.keepAlive = true;
      console.log(`[Telegram] 使用 SOCKS 代理: ${safeProxyLabel(proxyUrl)}`);
      return agent;
    }
    if (proxyAgentFactory) {
      const agent = new proxyAgentFactory.HttpsProxyAgent(proxyUrl);
      agent.keepAlive = true;
      return agent;
    }
  } catch {}
  // 代理已配置但未安装代理依赖
  try {
    console.warn(`[Telegram] 已检测到代理 ${safeProxyLabel(proxyUrl)}，但未安装代理依赖。请安装: npm i https-proxy-agent socks-proxy-agent`);
  } catch {}
  return null;
}

function safeProxyLabel(url) {
  try {
    const u = new URL(url);
    const auth = u.username || u.password ? "***@" : "";
    return `${u.protocol}//${auth}${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
  } catch {
    return "(invalid proxy url)";
  }
}

function tgApi(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const agent = buildAgentFromEnv();
    const reqTimeoutMs = (method === "getUpdates" && payload && typeof payload.timeout === "number")
      ? Math.max(1000, payload.timeout * 1000 + 10000) // 长轮询：超时 = 服务器超时 + 10s 裕度
      : 20000;
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${TG_BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      agent,
    }, (res) => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", (c) => body += c);
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", reject);
    req.setTimeout(reqTimeoutMs, () => req.destroy(new Error("timeout")));
    req.write(data); req.end();
  });
}

function shortenUrl(u, maxLen = 50) {
  try {
    const s = String(u);
    if (s.length <= maxLen) return s;
    const head = s.slice(0, Math.max(0, Math.floor(maxLen * 0.6)));
    const tail = s.slice(-Math.max(0, Math.floor(maxLen * 0.3)));
    return `${head}…${tail}`;
  } catch { return String(u); }
}

function getHost(u) {
  try { return new URL(String(u)).host; } catch { return "unknown"; }
}

async function sendMediaGroup({ urls }) {
  if (!TG_BOT_TOKEN || !Array.isArray(TG_CHAT_IDS) || TG_CHAT_IDS.length === 0) return;
  if (!Array.isArray(urls) || urls.length === 0) return;
  const media = urls.slice(0, 10).map((u, i) => ({
    type: "photo",
    media: u,
    caption: `图${i + 1}: ${shortenUrl(u)}`,
  }));
  const sent = [];
  for (const chat_id of TG_CHAT_IDS) {
    const resp = await tgApi("sendMediaGroup", { chat_id, media });
    if (resp && resp.ok && Array.isArray(resp.result)) {
      // 记录每条消息
      for (const m of resp.result) {
        sent.push({ chat_id, message_id: m.message_id });
      }
    }
  }
  return { sent };
}

async function sendPhotoPoll({ question, options, allows_multiple_answers = true }) {
  if (!TG_BOT_TOKEN || !Array.isArray(TG_CHAT_IDS) || TG_CHAT_IDS.length === 0) return;
  const pollOptions = options.map((u, idx) => `${idx + 1}. ${getHost(u)}`);
  const sent = [];
  for (const chatId of TG_CHAT_IDS) {
    const resp = await tgApi("sendPoll", { chat_id: chatId, question, options: pollOptions, allows_multiple_answers, is_anonymous: false });
    if (resp && resp.ok && resp.result && resp.result.poll) {
      sent.push({ chat_id: chatId, message_id: resp.result.message_id, poll_id: resp.result.poll.id });
    }
  }
  return { sent, options };
}

async function getUpdates(offset) {
  if (!TG_BOT_TOKEN) return null;
  const resp = await tgApi("getUpdates", { offset, timeout: 25, allowed_updates: ["poll", "poll_answer"] });
  return resp && resp.ok ? resp.result : [];
}

async function stopPoll(chat_id, message_id) {
  if (!TG_BOT_TOKEN) return null;
  return await tgApi("stopPoll", { chat_id, message_id });
}

module.exports = { sendPhotoPoll, getUpdates, sendMediaGroup, shortenUrl, stopPoll };


