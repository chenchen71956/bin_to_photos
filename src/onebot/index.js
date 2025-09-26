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

let globalOnebotWs;
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

function callApi(ws, action, params, timeoutMs = 15000) {
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
    }, Math.max(1, Number(timeoutMs || 0)));
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
  const timeoutMs = imageBase64List.length > 0 ? 30000 : 15000;
  async function withRetry(fn, label, attempts = 3) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const r = await fn();
        try { console.log(`[OneBot][${label}] OK try#${i}`); } catch {}
        return r;
      } catch (err) {
        lastErr = err;
        try { console.warn(`[OneBot][${label}] FAIL try#${i}: ${err && err.message ? err.message : err}`); } catch {}
        if (i < attempts) { await new Promise((r) => setTimeout(r, i * 400)); }
      }
    }
    throw lastErr;
  }

  try {
    if (event.message_type === "private") {
      await withRetry(() => callApi(ws, "send_msg", sendPayloadPrivate, timeoutMs), "send_msg-agg");
    } else if (event.message_type === "group") {
      await withRetry(() => callApi(ws, "send_msg", sendPayloadGroup, timeoutMs), "send_msg-agg");
    }
    try { console.log(`[OneBot][send_msg] OK images=${imageBase64List.length} ${Date.now() - tSend}ms`); } catch {}
  } catch (e) {
    try { console.error(`[OneBot][send_msg] FAIL images=${imageBase64List.length}: ${e && e.message ? e.message : e}`); } catch {}
    // 回退方案：先发文本，再逐张图片单独发送（各自重试）
    try {
      console.warn("[OneBot] 进入回退发送: 文本+逐图");
      const sendSingle = async (message) => {
        const pvt = { message_type: "private", user_id: event.user_id, message };
        const grp = { message_type: "group", group_id: event.group_id, message };
        if (event.message_type === "private") {
          return await withRetry(() => callApi(ws, "send_msg", pvt, timeoutMs), "send_msg-fallback");
        } else {
          return await withRetry(() => callApi(ws, "send_msg", grp, timeoutMs), "send_msg-fallback");
        }
      };
      // 文本
      await sendSingle(replyText);
      // 逐图
      for (const base64 of imageBase64List) {
        const imageSeg = [{ type: "image", data: { file: `base64://${base64}` } }];
        await sendSingle(imageSeg);
        await new Promise((r) => setTimeout(r, 250));
      }
      console.log("[OneBot] 回退发送完成");
    } catch (e2) {
      try { console.error(`[OneBot] 回退发送仍失败: ${e2 && e2.message ? e2.message : e2}`); } catch {}
      throw e2;
    }
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

async function notifyNewBinInserted(bin, pickedUrls) {
  const env = process.env.ADMIN_GROUP_IDS || process.env.ADMIN_GROUP_ID || "";
  const ids = String(env)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return;

  let remote = null;
  try {
    remote = await httpGetJson(buildRequestUrl(bin));
  } catch {}
  const data = (remote && typeof remote === "object") ? remote : {};
  const empty = "---";
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
    "新BIN入库啦：",
    `BIN：${valueOr(data.bin || bin)}`,
    `品牌：${v("brand")}`,
    `類型：${v("type")}`,
    `卡片等級：${v("category")}`,
    `發卡行：${v("issuer")}`,
    `國家：${v("country")}`,
    `發卡行電話：${v("issuerPhone")}`,
    `發卡行網址：${v("issuerUrl")}`,
  ];
  const text = lines.join("\n");

  // 预览图：尽可能发送所有可用图片（最多 10 张）
  let previewBase64List = [];
  try {
    let urls = [];
    if (Array.isArray(pickedUrls) && pickedUrls.length > 0) {
      urls = pickedUrls;
    } else {
      try {
        const { getBinPhotos } = require("../db");
        urls = getBinPhotos(bin) || [];
      } catch {}
    }
    const top = urls.slice(0, 10);
    for (let i = 0; i < top.length; i++) {
      try {
        const buf = await httpGetBuffer(top[i]);
        if (buf && buf.length > 0) previewBase64List.push(buf.toString("base64"));
      } catch {}
    }
  } catch {}

  async function withRetry(fn, label, attempts = 3) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try { return await fn(); }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, i * 300)); }
    }
    throw lastErr;
  }

  const sendTo = async (chatId) => {
    try {
      await withRetry(() => callApi(globalOnebotWs, "send_msg", { message_type: "group", group_id: chatId, message: text }, 15000), "admin-text");
      for (const b64 of previewBase64List) {
        const imageSeg = [{ type: "image", data: { file: `base64://${b64}` } }];
        await withRetry(() => callApi(globalOnebotWs, "send_msg", { message_type: "group", group_id: chatId, message: imageSeg }, 30000), "admin-image");
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e) {
      try { console.warn(`[OneBot] 管理群通知失败 chat=${chatId}:`, e && e.message ? e.message : e); } catch {}
    }
  };
  for (const gid of ids) {
    await sendTo(/^-?\d+$/.test(gid) ? Number(gid) : gid);
  }
}

function main() {
  try { initDb(process.env.BIN_PHOTOS_DB_PATH); } catch {}
  const headers = {};
  if (ACCESS_TOKEN && ACCESS_TOKEN.trim().length > 0) {
    headers["Authorization"] = `Bearer ${ACCESS_TOKEN}`;
  }
  const ws = new WebSocket(WS_URL, { headers });
  globalOnebotWs = ws;

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
          if (urls.length === 1) {
            // 单链接审核流：发图+通过/不通过按钮
            const one = urls[0];
            const q = parsed.bin ? `BIN ${parsed.bin} 单链接审核` : `单链接审核`;
            console.log(`[Telegram] 单链接审核: issue=#${it.number}`);
            try {
              const { TG_CHAT_IDS } = require("../telegram/config");
              const { sendSingleApproval } = require("../telegram/bot");
              if (Array.isArray(TG_CHAT_IDS) && TG_CHAT_IDS.length > 0) {
                for (const chatId of TG_CHAT_IDS) {
                  await sendSingleApproval({ url: one, bin: parsed.bin || "", chatId, owner, repo, number: it.number });
                }
              } else {
                console.warn("[Telegram] 未配置 TG_CHAT_IDS，无法发送单链接审核");
              }
            } catch (e) {
              console.warn(`[Telegram] 单链接审核发送失败:`, e && e.message ? e.message : e);
            }
          } else if (urls.length > 0) {
            const q = parsed.bin ? `Issue #${it.number} | BIN ${parsed.bin} | 多选投票` : `Issue #${it.number} | 多选投票`;
            console.log(`[Telegram] 准备发起投票: issue=#${it.number}, urls=${urls.length}`);
            try {
              // 先发图片组
              await sendMediaGroup({ urls });
              // 追加“不通过”选项到投票底部
              const pollOptions = [...urls, "__REJECT__"];
              const sent = await sendPhotoPoll({ question: q, options: pollOptions, allows_multiple_answers: true });
              if (sent && Array.isArray(sent.sent) && sent.sent.length > 0) {
                for (const item of sent.sent) {
                  insertTgPollMapping({ poll_id: item.poll_id, owner, repo, number: it.number, bin: parsed.bin || null, chat_id: item.chat_id, message_id: item.message_id, options: pollOptions });
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
module.exports.notifyNewBinInserted = notifyNewBinInserted;


