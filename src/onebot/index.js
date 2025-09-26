#!/usr/bin/env node
"use strict";

require("dotenv").config();
const WebSocket = require("ws");
const { buildRequestUrl, httpGetJson, httpGetBuffer } = require("../check");
const { getBinPhotos, initDb, hasIssue, insertIssueIfNew } = require("../db");
const { listAllOpenIssues, parseBinAndUrlsFromText } = require("../github");
const { sendPhotoPoll, sendMediaGroup } = require("../telegram/bot");
const { startTelegramPolling, insertTgPollMapping } = require("../telegram/poller");

const WS_URL = process.env.WS_URL;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";

if (!WS_URL) {
  console.error("[OneBot] 缺少 WS_URL，请在环境变量中配置 OneBot WS 地址");
  process.exit(1);
}

const pendingEchoMap = new Map();

function shortUrl(u) {
  try {
    const url = new URL(u);
    const pathname = url.pathname || "/";
    const shortPath = pathname.length > 60 ? pathname.slice(0, 60) + "..." : pathname;
    return `${url.hostname}${shortPath}`;
  } catch {
    const s = String(u || "");
    return s.length > 80 ? s.slice(0, 80) + "..." : s;
  }
}

function generateEcho() {
  return `echo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getMessagePlainText(event) {
  if (typeof event.message === "string") return event.message;
  if (Array.isArray(event.message)) {
    return event.message
      .filter((seg) => seg && seg.type === "text")
      .map((seg) => (seg && seg.data && typeof seg.data.text === "string" ? seg.data.text : ""))
      .join("");
  }
  if (typeof event.raw_message === "string") return event.raw_message;
  return "";
}

function callApi(ws, action, params) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error("WS 未连接"));
    const echo = generateEcho();
    const startedAt = Date.now();
    pendingEchoMap.set(echo, { resolve, reject, action, startedAt });
    const payload = { action, params, echo };
    ws.send(JSON.stringify(payload), (err) => {
      if (err) {
        pendingEchoMap.delete(echo);
        reject(err);
      }
    });
    setTimeout(() => {
      if (pendingEchoMap.has(echo)) {
        pendingEchoMap.delete(echo);
        console.error(`[OneBot][API] 超时: action=${action}, echo=${echo}`);
        reject(new Error("API 调用超时"));
      }
    }, 15000);
  });
}

async function handleIncomingMessage(ws, event) {
  const rawText = getMessagePlainText(event);
  const match = /^\s*bin\s+(\d+)\s*$/i.exec(rawText);
  if (!match) return;

  const bin = match[1];
  const url = buildRequestUrl(bin);

  try {
    console.log(`[BIN] 收到查询: bin=${bin}, from=${event.message_type === "group" ? `group:${event.group_id}` : `user:${event.user_id}`}`);
  } catch {}

  let replyText;
  let imageBase64List = [];
  try {
    const tRemote = Date.now();
    const [remote] = await Promise.all([
      httpGetJson(url),
    ]);
    try { console.log(`[BIN] 远端BIN接口完成: ${Date.now() - tRemote}ms`); } catch {}
    replyText = formatBinReply(remote, bin);

    const photoUrls = getBinPhotos(bin) || [];
    try { console.log(`[BIN] DB 返回图片链接: ${photoUrls.length}`); } catch {}
    if (photoUrls.length > 0) {
      const maxImages = Math.min(photoUrls.length, 10);
      const slice = photoUrls.slice(0, maxImages);
      async function fetchWithRetry(u, idx) {
        const tag = `[IMG ${idx + 1}/${slice.length}] ${shortUrl(u)}`;
        const attempts = 3;
        let lastErr = null;
        for (let i = 1; i <= attempts; i++) {
          const t0 = Date.now();
          try {
            const buf = await httpGetBuffer(u);
            if (buf && buf.length > 0) {
              try { console.log(`${tag} OK size=${buf.length}B ${Date.now() - t0}ms try#${i}`); } catch {}
              return buf;
            }
            lastErr = new Error("empty buffer");
          } catch (e) {
            lastErr = e;
            const emsg = e && e.message ? e.message : String(e);
            try { console.warn(`${tag} FAIL ${emsg} try#${i}`); } catch {}
            if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Request timed out/i.test(emsg)) {
              // 网络类错误重试
            } else {
              break;
            }
          }
          await new Promise((r) => setTimeout(r, i * 300));
        }
        try { console.warn(`${tag} GIVEUP: ${lastErr && lastErr.message ? lastErr.message : lastErr}`); } catch {}
        return null;
      }

      // 限制并发，减少瞬时连接峰值导致的 ECONNRESET
      const concurrency = 2;
      const buffers = new Array(slice.length);
      let nextIndex = 0;
      async function worker() {
        while (true) {
          const i = nextIndex++;
          if (i >= slice.length) break;
          buffers[i] = await fetchWithRetry(slice[i], i);
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, slice.length) }, () => worker());
      await Promise.all(workers);
      const valid = buffers.filter((b) => b && b.length > 0);
      imageBase64List = valid.map((buf) => buf.toString("base64"));
      try { console.log(`[BIN] 有效图片: ${imageBase64List.length}/${slice.length}`); } catch {}
    }
  } catch (err) {
    replyText = `查询失败: ${err.message || err}`;
  }

  const segments = [{ type: "text", data: { text: replyText } }];
  for (const base64 of imageBase64List) {
    segments.push({ type: "image", data: { file: `base64://${base64}` } });
  }

  try { console.log(`[BIN] 准备发送: images=${imageBase64List.length}, text_len=${(replyText || "").length}`); } catch {}

  const sendPayloadPrivate = { message_type: "private", user_id: event.user_id, message: imageBase64List.length ? segments : replyText };
  const sendPayloadGroup = { message_type: "group", group_id: event.group_id, message: imageBase64List.length ? segments : replyText };
  const tSend = Date.now();
  try {
    if (event.message_type === "private") {
      await callApi(ws, "send_msg", sendPayloadPrivate);
    } else if (event.message_type === "group") {
      await callApi(ws, "send_msg", sendPayloadGroup);
    }
    try { console.log(`[OneBot][send_msg] OK images=${imageBase64List.length} ${Date.now() - tSend}ms`); } catch {}
  } catch (e) {
    try { console.error(`[OneBot][send_msg] FAIL images=${imageBase64List.length}: ${e && e.message ? e.message : e}`); } catch {}
    throw e;
  }
}

function formatBinReply(result, requestedBin) {
  const empty = "---";
  const data = (result && typeof result === "object") ? result : {};
  const v = (key) => {
    const val = data[key];
    if (val === undefined || val === null) return empty;
    if (typeof val === "string" && val.trim() === "") return empty;
    return String(val);
  };
  const valueOr = (value) => {
    if (value === undefined || value === null) return empty;
    if (typeof value === "string" && value.trim() === "") return empty;
    return String(value);
  };
  const lines = [
    `BIN：${valueOr(data.bin || requestedBin)}`,
    `品牌：${v("brand")}`,
    `類型：${v("type")}`,
    `卡片等級：${v("category")}`,
    `發卡行：${v("issuer")}`,
    `國家：${v("country")}`,
    `發卡行電話：${v("issuerPhone")}`,
    `發卡行網址：${v("issuerUrl")}`,
  ];
  return lines.join("\n");
}

function main() {
  try { initDb(process.env.BIN_PHOTOS_DB_PATH); } catch {}
  const headers = {};
  if (ACCESS_TOKEN && ACCESS_TOKEN.trim().length > 0) {
    headers["Authorization"] = `Bearer ${ACCESS_TOKEN}`;
  }
  const ws = new WebSocket(WS_URL, { headers });

  ws.on("open", () => {
    console.log(`[OneBot] 已连接: ${WS_URL}`);
    // 启动 GitHub 轮询与 Telegram 轮询
    startGithubPolling();
    console.log("[Telegram] 开始轮询投票更新");
    startTelegramPolling();
  });

  ws.on("close", (code, reason) => {
    console.log(`[OneBot] 连接关闭: code=${code}, reason=${reason}`);
    setTimeout(() => main(), 2000);
  });

  ws.on("error", (err) => {
    console.error("[OneBot] 连接错误:", err.message || err);
  });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.echo && pendingEchoMap.has(msg.echo)) {
      const pending = pendingEchoMap.get(msg.echo);
      pendingEchoMap.delete(msg.echo);
      try {
        const cost = pending && pending.startedAt ? (Date.now() - pending.startedAt) : null;
        const detail = `ret=${(msg && (msg.retcode !== undefined ? msg.retcode : msg.status)) ?? ""}`;
        if (pending && pending.action) {
          console.log(`[OneBot][API] <- action=${pending.action}, echo=${msg.echo} ${detail} ${cost !== null ? cost + "ms" : ""}`);
        }
      } catch {}
      pending.resolve(msg);
      return;
    }
    if (msg.post_type === "message") {
      handleIncomingMessage(ws, msg).catch((err) => console.error("处理消息失败:", err.message || err));
    }
  });
}

function combineAllUrls(parsed) {
  const a = Array.isArray(parsed?.attachUrls) ? parsed.attachUrls : [];
  const b = Array.isArray(parsed?.textUrls) ? parsed.textUrls : [];
  return [...a, ...b];
}

function startGithubPolling() {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    console.error("[GitHub] 缺少必要配置：GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN");
    return;
  }
  let busy = false;
  async function tick() {
    if (busy) return; busy = true;
    try {
      const list = await listAllOpenIssues({ owner, repo, token });
      if (!Array.isArray(list)) return;
      for (const it of list) {
        if ((it.state || "").toLowerCase() !== "open") continue;
        if (hasIssue(owner, repo, it.number)) continue;
        // 调试输出原始 GitHub Issue JSON（不截断）
        try {
          const raw = JSON.stringify(it);
          console.log(`[GitHub][raw] issue=#${it.number} ${raw}`);
        } catch {}
        const text = `${it.title || ""}\n\n${it.body || ""}`;
        const parsed = parseBinAndUrlsFromText(text);
        if (!parsed) {
          console.log(`[GitHub] Issue #${it.number} 未解析到 BIN/URL，跳过发起投票`);
        }
        insertIssueIfNew({
          owner, repo, number: it.number, title: it.title, body: it.body, state: it.state,
          created_at: it.created_at, updated_at: it.updated_at,
          parsed_bin: parsed ? parsed.bin : null,
          text_urls: parsed ? parsed.textUrls : null,
          attach_urls: parsed ? parsed.attachUrls : null,
        });
        if (parsed) {
          const urls = combineAllUrls(parsed).slice(0, 10);
          if (urls.length > 0) {
            const q = parsed.bin ? `Issue #${it.number} | BIN ${parsed.bin} | 多选投票` : `Issue #${it.number} | 多选投票`;
            console.log(`[Telegram] 准备发起投票: issue=#${it.number}, urls=${urls.length}`);
            try {
              // 先发图片组
              await sendMediaGroup({ urls });
              const sent = await sendPhotoPoll({ question: q, options: urls, allows_multiple_answers: true });
              if (sent && Array.isArray(sent.sent) && sent.sent.length > 0) {
                for (const item of sent.sent) {
                  insertTgPollMapping({ poll_id: item.poll_id, owner, repo, number: it.number, bin: parsed.bin || null, chat_id: item.chat_id, message_id: item.message_id, options: urls });
                }
                console.log(`[Telegram] 投票已发送: issue=#${it.number}, polls=${sent.sent.length}`);
              } else {
                console.warn(`[Telegram] sendPhotoPoll 未返回有效结果，可能未配置 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID`);
              }
            } catch {}
          }
          else {
            console.log(`[GitHub] Issue #${it.number} 未找到可用链接，跳过发起投票`);
          }
        }
      }
    } finally {
      busy = false;
    }
  }
  tick();
  setInterval(() => { tick().catch(() => {}); }, 1000);
}

if (require.main === module) {
  main();
}

module.exports = { main };


