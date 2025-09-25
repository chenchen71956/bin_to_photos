"use strict";

const { httpGetBuffer } = require("../../check");
const { insertVoteRecord, upsertBinPhotosSplit } = require("../../db");
const { closeIssue, createIssueComment } = require("../../github");
const { getMessagePlainText, extractReplyTargetMessageId } = require("../utils");
const { sendGroup, callApi } = require("../sender");

// 多群联合投票的内存会话
const issueSessions = new Map(); // key: owner/repo#number -> session
const messageIdToIssueKey = new Map(); // messageId -> issueKey

function getIssueKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

async function startVoteForIssue(ws, { owner, repo, number, parsed, groupIds }) {
  const issueKey = getIssueKey(owner, repo, number);
  let sess = issueSessions.get(issueKey);
  const now = Date.now();
  if (!sess) {
    sess = {
      issueKey, owner, repo, number,
      bin: parsed?.bin || null,
      textUrls: parsed?.textUrls || [],
      attachUrls: parsed?.attachUrls || [],
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
  if (parsed?.bin) segments.push({ type: "text", data: { text: `BIN: ${parsed.bin}\n` } });

  const allUrls = [ ...(parsed?.attachUrls || []), ...(parsed?.textUrls || []) ];
  const maxItems = Math.min(allUrls.length, 15);
  const chosen = allUrls.slice(0, maxItems);
  let buffers = [];
  try { buffers = await Promise.all(chosen.map(async (u) => { try { return await httpGetBuffer(u); } catch { return null; } })); } catch {}
  for (let i = 0; i < chosen.length; i++) {
    const u = chosen[i];
    const buf = buffers[i];
    segments.push({ type: "text", data: { text: `[${u} ]\n` } });
    if (buf && buf.length > 0) {
      segments.push({ type: "image", data: { file: `base64://${buf.toString("base64")}` } });
    } else {
      segments.push({ type: "text", data: { text: "(图片下载失败)\n" } });
    }
  }
  segments.push({ type: "text", data: { text: "\n15分钟内回复本消息：通过 或 不通过（仅统计回复本消息的投票）" } });

  for (const gid of groupIds || []) {
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

function handleGroupReply(ws, msg) {
  if (msg.message_type !== "group") return;
  const replyId = extractReplyTargetMessageId(msg);
  if (!replyId) return;
  const issueKey = messageIdToIssueKey.get(String(replyId));
  if (!issueKey) return;
  const sess = issueSessions.get(issueKey);
  if (!sess) return;
  const text = getMessagePlainText(msg);
  const compact = (text || "").replace(/\s+/g, "");
  if (/^通过$/i.test(compact)) {
    sess.votes.set(String(msg.user_id), "approve");
    try { insertVoteRecord({ owner: sess.owner, repo: sess.repo, number: sess.number, user_id: msg.user_id, intent: "approve", group_id: msg.group_id }); } catch {}
  } else if (/^不通过$/i.test(compact)) {
    sess.votes.set(String(msg.user_id), "reject");
    try { insertVoteRecord({ owner: sess.owner, repo: sess.repo, number: sess.number, user_id: msg.user_id, intent: "reject", group_id: msg.group_id }); } catch {}
  }
}

async function finalizeSession(ws, sess) {
  const approve = [...sess.votes.values()].filter((v) => v === "approve").length;
  const reject = [...sess.votes.values()].filter((v) => v === "reject").length;
  const total = approve + reject;
  if ((total === 0 || approve === reject) && !sess.extended) {
    sess.deadlineAt = Date.now() + 5 * 60 * 1000;
    sess.extended = true;
    const anyGroup = [...sess.groupIds][0];
    if (anyGroup) await callApi(ws, "send_msg", { message_type: "group", group_id: anyGroup, message: "投票持平或无人投票，进入五分钟加时赛。" });
    return false;
  }
  const approved = approve > reject;
  let inserted = false;
  if (approved && sess.bin) {
    try { inserted = !!upsertBinPhotosSplit(sess.bin, sess.textUrls, sess.attachUrls); } catch {}
  }
  try {
    const token = process.env.GITHUB_TOKEN;
    if (token) {
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
  const resultLines = [
    `投票结束啦，被入库的BIN：${approved && inserted ? sess.bin : "无"}`,
    `投票结果：${approved ? "通过" : "不通过"}`,
    `总人数=${total}`,
    `不通过=${reject}`,
    `通过=${approve}`,
  ];
  for (const gid of sess.groupIds) await callApi(ws, "send_msg", { message_type: "group", group_id: gid, message: resultLines.join("\n") });
  return true;
}

function startTimer() {
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
}

module.exports = { startVoteForIssue, handleGroupReply, startTimer };


