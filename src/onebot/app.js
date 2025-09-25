#!/usr/bin/env node
"use strict";

const WebSocket = require("ws");
const { buildRequestUrl, httpGetJson, httpGetBuffer } = require("../check");
const { getBinPhotos, upsertBinPhotos, hasIssue, insertIssueIfNew, insertVoteRecord } = require("../db");
const { listAllOpenIssues, parseBinAndUrlsFromText } = require("../github");
const { WS_URL, ACCESS_TOKEN, ADMIN_GROUP_IDS } = require("./config");
const { generateEcho, getMessagePlainText, extractReplyTargetMessageId, normalizeUrlForDedupe } = require("./utils");

const pendingEchoMap = new Map();

function createWsClient() {
  const headers = {};
  if (ACCESS_TOKEN && ACCESS_TOKEN.trim().length > 0) {
    headers["Authorization"] = `Bearer ${ACCESS_TOKEN}`;
  }

  const ws = new WebSocket(WS_URL, { headers });

  ws.on("open", () => {
    console.log(`[OneBot] 已连接: ${WS_URL}`);
    startGithubPolling(ws).catch(() => {});
    global.__onebot_ws__ = ws;
  });

  ws.on("close", (code, reason) => {
    console.log(`[OneBot] 连接关闭: code=${code}, reason=${reason}`);
    setTimeout(() => createWsClient(), 2000);
  });

  ws.on("error", (err) => {
    console.error("[OneBot] 连接错误:", err.message || err);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    if (msg.echo && pendingEchoMap.has(msg.echo)) {
      const { resolve } = pendingEchoMap.get(msg.echo);
      pendingEchoMap.delete(msg.echo);
      resolve(msg);
      return;
    }

    if (msg.post_type === "message") {
      try {
        const preview = getMessagePlainText(msg).slice(0, 120);
        console.log(`[OneBot] 收到消息: type=${msg.message_type} text="${preview}"`);
      } catch {}
      if (msg.message_type === "group") {
        const replyId = extractReplyTargetMessageId(msg);
        if (replyId && messageIdToIssueKey.has(String(replyId))) {
          const issueKey = messageIdToIssueKey.get(String(replyId));
          const sess = issueSessions.get(issueKey);
          const text = getMessagePlainText(msg);
          const compact = (text || "").replace(/\s+/g, "");
          if (/^通过$/i.test(compact)) {
            sess.votes.set(String(msg.user_id), "approve");
            try { insertVoteRecord({ owner: sess.owner, repo: sess.repo, number: sess.number, user_id: msg.user_id, intent: "approve", group_id: msg.group_id }); } catch {}
            console.log(`[Vote] +1 通过 from ${msg.user_id} for ${replyId}`);
          } else if (/^不通过$/i.test(compact)) {
            sess.votes.set(String(msg.user_id), "reject");
            try { insertVoteRecord({ owner: sess.owner, repo: sess.repo, number: sess.number, user_id: msg.user_id, intent: "reject", group_id: msg.group_id }); } catch {}
            console.log(`[Vote] +1 不通过 from ${msg.user_id} for ${replyId}`);
          }
        }
      }
      handleIncomingMessage(ws, msg).catch((err) => {
        console.error("处理消息失败:", err.message || err);
      });
    }
  });

  return ws;
}

// 多群联合投票
const issueSessions = new Map();
const messageIdToIssueKey = new Map();

async function startVoteForIssue(ws, { owner, repo, number, parsed }) {
  if (!ADMIN_GROUP_IDS || ADMIN_GROUP_IDS.length === 0) return;
  const issueKey = `${owner}/${repo}#${number}`;
  let sess = issueSessions.get(issueKey);
  const now = Date.now();
  if (!sess) {
    sess = {
      issueKey,
      owner,
      repo,
      number,
      bin: parsed ? parsed.bin : null,
      textUrls: parsed ? parsed.textUrls || [] : [],
      attachUrls: parsed ? parsed.attachUrls || [] : [],
      createdAt: now,
      deadlineAt: now + 15 * 60 * 1000,
      extended: false,
      votes: new Map(),
      groupIds: new Set(),
      messageIds: new Set(),
    };
    issueSessions.set(issueKey, sess);
  }

  const issueUrl = `https://github.com/${owner}/${repo}/issues/${number}`;
  const segments = [];
  segments.push({ type: "text", data: { text: `您有新的审了吗订单 Issue #${number}，请及时处理\n` } });
  segments.push({ type: "text", data: { text: `${issueUrl} }\n\n` } });
  if (parsed && parsed.bin) segments.push({ type: "text", data: { text: `BIN: ${parsed.bin}\n` } });
  const allUrls = [ ...(parsed?.attachUrls || []), ...(parsed?.textUrls || []) ];
  const maxItems = Math.min(allUrls.length, 15);
  const chosen = allUrls.slice(0, maxItems);
  let buffers = [];
  try { buffers = await Promise.all(chosen.map(async (u) => { try { return await httpGetBuffer(u); } catch { return null; } })); } catch {}
  for (let i = 0; i < chosen.length; i++) {
    const u = chosen[i];
    const buf = buffers[i];
    segments.push({ type: "text", data: { text: `[${u} ]\n` } });
    if (buf && buf.length > 0) { segments.push({ type: "image", data: { file: `base64://${buf.toString("base64")}` } }); }
    else { segments.push({ type: "text", data: { text: "(图片下载失败)\n" } }); }
  }
  segments.push({ type: "text", data: { text: "\n15分钟内回复本消息：通过 或 不通过（仅统计回复本消息的投票）" } });

  for (const gid of ADMIN_GROUP_IDS) {
    try {
      const resp = await sendGroup(ws, gid, segments);
      const messageId = resp && resp.data && (resp.data.message_id || resp.data.messageId || resp.data.message?.message_id);
      if (!messageId) continue;
      messageIdToIssueKey.set(String(messageId), issueKey);
      sess.groupIds.add(gid);
      sess.messageIds.add(String(messageId));
    } catch {}
  }
}

async function finalizeSession(ws, sess) {
  const approve = [...sess.votes.values()].filter((v) => v === "approve").length;
  const reject = [...sess.votes.values()].filter((v) => v === "reject").length;
  const total = approve + reject;
  if ((total === 0 || approve === reject) && !sess.extended) {
    sess.deadlineAt = Date.now() + 5 * 60 * 1000;
    sess.extended = true;
    await callApi(ws, "send_msg", { message_type: "group", group_id: [...sess.groupIds][0], message: "投票持平或无人投票，进入五分钟加时赛。" });
    return false;
  }
  const approved = approve > reject;
  let inserted = false;
  if (approved && sess.bin) {
    try {
      const { upsertBinPhotosSplit } = require("../db");
      inserted = !!upsertBinPhotosSplit(sess.bin, sess.textUrls, sess.attachUrls);
    } catch {}
  }
  try {
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      const { closeIssue, createIssueComment } = require("../github");
      const body = [
        `投票结束啦，被入库的BIN：${approved && inserted ? sess.bin : "无"}`,
        `投票结果：${approved ? "通过" : "不通过"}`,
        `总人数=${total}`,
        `不通过=${reject}`,
        `通过=${approve}`,
      ].join("\n");
      await createIssueComment({ owner: sess.owner, repo: sess.repo, number: sess.number, token, body });
      await closeIssue({ owner: sess.owner, repo: sess.repo, number: sess.number, token });
    }
  } catch {}
  const resultLines = [];
  resultLines.push(`投票结束啦，被入库的BIN：${approved && inserted ? sess.bin : "无"}`);
  resultLines.push(`投票结果：${approved ? "通过" : "不通过"}`);
  resultLines.push(`总人数=${total}`);
  resultLines.push(`不通过=${reject}`);
  resultLines.push(`通过=${approve}`);
  for (const gid of sess.groupIds) {
    await callApi(ws, "send_msg", { message_type: "group", group_id: gid, message: resultLines.join("\n") });
  }
  return true;
}

setInterval(async () => {
  if (issueSessions.size === 0) return;
  const now = Date.now();
  for (const [key, sess] of [...issueSessions.entries()]) {
    if (now >= sess.deadlineAt) {
      try {
        const ws = global.__onebot_ws__;
        if (!ws) continue;
        const done = await finalizeSession(ws, sess);
        if (done) {
          issueSessions.delete(key);
          for (const mid of sess.messageIds) messageIdToIssueKey.delete(mid);
        }
      } catch {}
    }
  }
}, 5000);

async function startGithubPolling(ws) {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    console.error("[GitHub] 缺少必要配置：GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN");
    return;
  }
  const intervalSec = 1;
  console.log(`[GitHub] 轮询间隔: ${intervalSec}s`);
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const list = await listAllOpenIssues({ owner, repo, token });
      if (!Array.isArray(list)) return;
      for (const it of list) {
        const isOpen = (it.state || "").toLowerCase() === "open";
        if (!isOpen) continue;
        if (hasIssue(owner, repo, it.number)) continue;
        const text = `${it.title || ""}\n\n${it.body || ""}`;
        const parsed = parseBinAndUrlsFromText(text);
        insertIssueIfNew({
          owner,
          repo,
          number: it.number,
          title: it.title,
          body: it.body,
          state: it.state,
          created_at: it.created_at,
          updated_at: it.updated_at,
          parsed_bin: parsed ? parsed.bin : null,
          text_urls: parsed ? parsed.textUrls : null,
          attach_urls: parsed ? parsed.attachUrls : null,
        });
        if (parsed) {
          await startVoteForIssue(ws, { owner, repo, number: it.number, parsed });
        }
      }
    } catch {}
    finally { ticking = false; }
  }
  await tick();
  setInterval(() => { tick().catch(() => {}); }, intervalSec * 1000);
}

function callApi(ws, action, params) {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error("WS 未连接"));
    const echo = generateEcho();
    pendingEchoMap.set(echo, { resolve, reject });
    const payload = { action, params, echo };
    try {
      let target = params && (params.user_id || params.group_id);
      let mtype = params && params.message_type;
      let summary = "";
      if (params && Array.isArray(params.message)) {
        const segs = params.message;
        const imgCount = segs.filter((s) => s && s.type === "image").length;
        const txtChars = segs.filter((s) => s && s.type === "text" && s.data && typeof s.data.text === "string").map((s) => s.data.text.length).reduce((a, b) => a + b, 0);
        summary = `segments=${segs.length}, images=${imgCount}, textChars=${txtChars}`;
      } else if (params && typeof params.message === "string") {
        const preview = params.message.replace(/\s+/g, " ").slice(0, 120);
        summary = `text='${preview}'`;
      }
      console.log(`[Send] action=${action} type=${mtype} to=${target} ${summary}`);
    } catch {}
    ws.send(JSON.stringify(payload), (err) => {
      if (err) {
        pendingEchoMap.delete(echo);
        reject(err);
      }
    });
    setTimeout(() => {
      if (pendingEchoMap.has(echo)) {
        pendingEchoMap.delete(echo);
        reject(new Error("API 调用超时"));
      }
    }, 15000);
  });
}

async function sendGroup(ws, groupId, message) {
  try {
    return await callApi(ws, "send_msg", { message_type: "group", group_id: groupId, message });
  } catch (e) {
    console.error(`[Send][group=${groupId}] 失败:`, e && e.message ? e.message : e);
    throw e;
  }
}

async function handleIncomingMessage(ws, event) {
  const rawText = getMessagePlainText(event);
  const adminQQ = parseInt(process.env.ADMIN_QQ || "0", 10) || 0;
  if (/^\s*binadd\b/i.test(rawText) && adminQQ && event.user_id === adminQQ) {
    const text = rawText.replace(/^\s*binadd\b/i, "").trim();
    const binMatch = text.match(/\b(\d{6})\b/);
    const urlMatches = [...text.matchAll(/https?:\/\/\S+/gi)].map((m) => m[0]);
    if (binMatch && urlMatches.length > 0) {
      const ok = upsertBinPhotos(binMatch[1], urlMatches);
      const reply = ok ? `已添加 BIN ${binMatch[1]} 的 ${urlMatches.length} 张图片` : `写入失败`;
      await callApi(ws, "send_msg", { message_type: event.message_type, user_id: event.user_id, group_id: event.group_id, message: reply });
    } else {
      await callApi(ws, "send_msg", { message_type: event.message_type, user_id: event.user_id, group_id: event.group_id, message: "用法: binadd <包含6位BIN> <一个或多个https链接>" });
    }
    return;
  }

  const match = /^\s*bin\s+(\d+)\s*$/i.exec(rawText);
  if (!match) return;
  const bin = match[1];
  const apiUrl = buildRequestUrl(bin);
  let replyText;
  let imageBase64List = [];
  try {
    const [remote] = await Promise.all([ httpGetJson(apiUrl) ]);
    replyText = formatBinReply(remote, bin);
    let photoUrls = getBinPhotos(bin);
    if (photoUrls && photoUrls.length > 0) {
      const seen = new Map();
      const deduped = [];
      for (const u of photoUrls) {
        const key = normalizeUrlForDedupe(u);
        if (seen.has(key)) continue;
        seen.set(key, true);
        deduped.push(u);
      }
      photoUrls = deduped;
      const maxImages = Math.min(photoUrls.length, 15);
      const slice = photoUrls.slice(0, maxImages);
      const buffers = await Promise.all(slice.map(async (u) => { try { return await httpGetBuffer(u); } catch { return null; } }));
      const validBuffers = buffers.filter((b) => b && b.length > 0);
      imageBase64List = validBuffers.map((buf) => buf.toString("base64"));
    } else {
      const owner = process.env.GITHUB_OWNER; const repo = process.env.GITHUB_REPO;
      if (owner && repo) {
        const reportUrl = `https://github.com/${owner}/${repo}/issues/new?template=bin-photos.md`;
        replyText += `\n\n查询不到卡面？通过以下链接进行卡面上报：\n${reportUrl}`;
      }
    }
  } catch (err) {
    replyText = `查询失败: ${err.message || err}`;
  }
  const segments = [{ type: "text", data: { text: replyText } }];
  for (const base64 of imageBase64List) segments.push({ type: "image", data: { file: `base64://${base64}` } });
  if (event.message_type === "private") await callApi(ws, "send_msg", { message_type: "private", user_id: event.user_id, message: imageBase64List.length > 0 ? segments : replyText });
  else if (event.message_type === "group") await callApi(ws, "send_msg", { message_type: "group", group_id: event.group_id, message: imageBase64List.length > 0 ? segments : replyText });
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

module.exports = { createWsClient, callApi };


