"use strict";

const { getUpdates, stopPoll, answerCallbackQuery } = require("./bot");
const { insertTgPollMapping, getTgPollById, finalizeTgPoll, replaceBinPhotos, getSingleApprovalByToken, deleteSingleApprovalByToken } = require("../db");
const { notifyNewBinInserted } = require("../onebot/index");
const { closeIssue, createIssueComment } = require("../github");

let lastUpdateId = 0;

async function startTelegramPolling() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  console.log("[Telegram] 开始轮询投票更新");
  setInterval(async () => {
    try {
      const updates = await getUpdates(lastUpdateId ? lastUpdateId + 1 : undefined);
      if (Array.isArray(updates) && updates.length > 0) {
        console.log(`[Telegram] 收到 updates: ${updates.length}`);
      }
      for (const upd of updates || []) {
        lastUpdateId = upd.update_id;
        if (upd.poll) {
          console.log(`[Telegram] poll update: id=${upd.poll.id} closed=${!!upd.poll.is_closed}`);
          await handlePoll(upd.poll);
        }
        if (upd.poll_answer) {
          const pa = upd.poll_answer;
          console.log(`[Telegram] poll_answer: poll_id=${pa.poll_id} user=${pa.user && pa.user.id} options=${Array.isArray(pa.option_ids) ? pa.option_ids.join(',') : ''}`);
          await handlePollAnswer(pa);
        }
        if (upd.callback_query) {
          await handleCallback(upd.callback_query);
        }
      }
    } catch (e) {
      console.error("[Telegram] 轮询错误:", e && e.message ? e.message : e);
    }
  }, 3000);
}

async function handlePoll(poll) {
  const pollId = poll.id;
  const rec = getTgPollById(pollId);
  if (!rec) {
    console.warn(`[Telegram] 未找到 poll 映射: poll_id=${pollId}`);
    return;
  }
  if (rec.finalized) {
    console.log(`[Telegram] poll 已标记完成: poll_id=${pollId}`);
    return;
  }
  if (!poll.is_closed) return; // 仅在投票关闭后处理结果
  try {
    let urls = [];
    try { urls = JSON.parse(rec.options_json) || []; } catch { urls = []; }
    // 收集所有被选择的索引
    const picked = [];
    const options = Array.isArray(poll.options) ? poll.options : [];
    for (let i = 0; i < options.length && i < urls.length; i++) {
      if ((options[i].voter_count || 0) > 0) picked.push(urls[i]);
    }
    console.log(`[Telegram] poll 关闭: poll_id=${pollId}, picked=${picked.length}`);
    const hasReject = picked.includes("__REJECT__");
    if (hasReject) {
      console.log(`[Telegram] 检测到不通过选项，立即关闭且不入库`);
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        const body = `上报的卡面被管理拒绝。BIN=${rec.bin || ''}`;
        try { await createIssueComment({ owner: rec.owner, repo: rec.repo, number: rec.number, token, body }); } catch {}
        try { await closeIssue({ owner: rec.owner, repo: rec.repo, number: rec.number, token }); } catch {}
      }
      return;
    }
    if (rec.bin && picked.length > 0) {
      const res = replaceBinPhotos(rec.bin, picked);
      console.log(`[DB] 覆盖写入集合: bin=${rec.bin}, count=${picked.length}, ok=${!!res.ok}, inserted=${!!res.inserted}`);
      if (res && res.inserted) {
        try { await notifyNewBinInserted(rec.bin, picked); } catch (e) { console.warn(`[OneBot] 管理群通知失败:`, e && e.message ? e.message : e); }
      }
    } else {
      console.warn(`[DB] 跳过写入: bin=${rec.bin}, picked=${picked.length}`);
    }
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      const body = `Telegram 投票已结束，选中链接数=${picked.length}`;
      try { await createIssueComment({ owner: rec.owner, repo: rec.repo, number: rec.number, token, body }); console.log(`[GitHub] 已评论 issue #${rec.number}`); } catch (e) { console.warn(`[GitHub] 评论失败 #${rec.number}:`, e && e.message ? e.message : e); }
      try { await closeIssue({ owner: rec.owner, repo: rec.repo, number: rec.number, token }); console.log(`[GitHub] 已关闭 issue #${rec.number}`); } catch (e) { console.warn(`[GitHub] 关闭失败 #${rec.number}:`, e && e.message ? e.message : e); }
    }
  } finally {
    finalizeTgPoll(pollId);
    console.log(`[Telegram] poll 标记完成: poll_id=${pollId}`);
  }
}

async function handlePollAnswer(ans) {
  // 一旦有人投票，就立即结束该投票并入库被选链接
  try {
    if (!ans || !ans.poll_id) return;
    const rec = getTgPollById(ans.poll_id);
    if (!rec || rec.finalized) return;
    let urls = [];
    try { urls = JSON.parse(rec.options_json) || []; } catch { urls = []; }
    const pickedIdx = Array.isArray(ans.option_ids) ? ans.option_ids : [];
    const picked = pickedIdx.map((i) => urls[i]).filter(Boolean);
    console.log(`[Telegram] 首票: poll_id=${ans.poll_id}, pickedIdx=${pickedIdx.join(',')}, picked=${picked.length}`);
    // 如果包含“不通过”，立即停止投票，不入库并关闭 issue
    if (picked.includes("__REJECT__")) {
      console.log(`[Telegram] 首票包含不通过，立即关闭投票，不入库`);
      try {
        const chatIdVal = /^-?\d+$/.test(String(rec.chat_id)) ? Number(rec.chat_id) : rec.chat_id;
        const msgIdVal = Number(rec.message_id);
        await stopPoll(chatIdVal, msgIdVal);
      } catch {}
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        const body = `Telegram 多选投票包含“不通过”，已拒绝并关闭 issue`;
        try { await createIssueComment({ owner: rec.owner, repo: rec.repo, number: rec.number, token, body }); } catch {}
        try { await closeIssue({ owner: rec.owner, repo: rec.repo, number: rec.number, token }); } catch {}
      }
      finalizeTgPoll(ans.poll_id);
      return;
    }
    if (rec.bin && picked.length > 0) {
      const res = replaceBinPhotos(rec.bin, picked);
      console.log(`[DB] 首票覆盖写入集合: bin=${rec.bin}, count=${picked.length}, ok=${!!res.ok}, inserted=${!!res.inserted}`);
      if (res && res.inserted) {
        try { await notifyNewBinInserted(rec.bin, picked); } catch (e) { console.warn(`[OneBot] 管理群通知失败:`, e && e.message ? e.message : e); }
      }
    } else {
      console.warn(`[DB] 首票跳过写入: bin=${rec.bin}, picked=${picked.length}`);
    }
    // 关闭投票：通过 stopPoll
    try {
      const chatIdVal = /^-?\d+$/.test(String(rec.chat_id)) ? Number(rec.chat_id) : rec.chat_id;
      const msgIdVal = Number(rec.message_id);
      const resp = await stopPoll(chatIdVal, msgIdVal);
      if (!resp || resp.ok !== true) {
        console.warn(`[Telegram] stopPoll 失败: chat_id=${rec.chat_id}, message_id=${rec.message_id}, resp=${JSON.stringify(resp)}`);
      }
    } catch (e) {
      console.warn(`[Telegram] stopPoll 异常:`, e && e.message ? e.message : e);
    }
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      const body = `Telegram 首票已产生，选中链接数=${picked.length}`;
      try { await createIssueComment({ owner: rec.owner, repo: rec.repo, number: rec.number, token, body }); console.log(`[GitHub] 已评论 issue #${rec.number}`); } catch (e) { console.warn(`[GitHub] 评论失败 #${rec.number}:`, e && e.message ? e.message : e); }
      try { await closeIssue({ owner: rec.owner, repo: rec.repo, number: rec.number, token }); console.log(`[GitHub] 已关闭 issue #${rec.number}`); } catch (e) { console.warn(`[GitHub] 关闭失败 #${rec.number}:`, e && e.message ? e.message : e); }
    }
  } finally {
    try { finalizeTgPoll(ans.poll_id); console.log(`[Telegram] 首票完成，已 finalize poll_id=${ans.poll_id}`); } catch {}
  }
}

async function handleCallback(cb) {
  try {
    const id = cb.id;
    const dataRaw = cb.data;
    let data;
    try { data = JSON.parse(String(dataRaw || "")); } catch { data = null; }
    if (!data || !data.t || !data.k) return;
    const rec = getSingleApprovalByToken(data.k);
    if (!rec || !rec.url || !rec.bin) return;
    if (data.t === "single_ok") {
      const res = replaceBinPhotos(rec.bin, [rec.url]);
      console.log(`[Telegram] 单链接审核通过: bin=${rec.bin}, ok=${!!res.ok}, inserted=${!!res.inserted}`);
      try { await answerCallbackQuery(id, "已通过"); } catch {}
      try { await notifyNewBinInserted(rec.bin, [rec.url]); } catch {}
    } else if (data.t === "single_ng") {
      try { await answerCallbackQuery(id, "已拒绝"); } catch {}
      const token = process.env.GITHUB_TOKEN;
      if (token && rec && rec.owner && rec.repo && rec.number != null) {
        const body = `上报的卡面被管理拒绝。BIN=${rec.bin || ''}`;
        try { await createIssueComment({ owner: rec.owner, repo: rec.repo, number: rec.number, token, body }); } catch {}
        try { await closeIssue({ owner: rec.owner, repo: rec.repo, number: rec.number, token }); } catch {}
      }
    }
    try { deleteSingleApprovalByToken(data.k); } catch {}
  } catch (e) {
    console.warn(`[Telegram] handleCallback 异常:`, e && e.message ? e.message : e);
  }
}

module.exports = { startTelegramPolling, insertTgPollMapping };


