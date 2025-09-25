#!/usr/bin/env node
"use strict";

const WebSocket = require("ws");
const { WS_URL, ACCESS_TOKEN, ADMIN_GROUP_IDS } = require("./config");
const { generateEcho, getMessagePlainText } = require("./utils");
const { callApi } = require("./sender");
const { startVoteForIssue, handleGroupReply, startTimer } = require("./features/vote");
const { handleBinQuery } = require("./features/query");
const { hasIssue, insertIssueIfNew } = require("../db");
const { listAllOpenIssues, parseBinAndUrlsFromText } = require("../github");

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
      if (msg.message_type === "group") handleGroupReply(ws, msg);
      handleIncomingMessage(ws, msg).catch((err) => {
        console.error("处理消息失败:", err.message || err);
      });
    }
  });

  return ws;
}

// 启动投票会话清理计时器
startTimer();

async function startVoteForIssue(ws, { owner, repo, number, parsed }) {
  if (!ADMIN_GROUP_IDS || ADMIN_GROUP_IDS.length === 0) return;
  await startVoteForIssue(ws, { owner, repo, number, parsed, groupIds: ADMIN_GROUP_IDS });
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
  const handled = await handleBinQuery(ws, event);
  if (handled) return;
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


