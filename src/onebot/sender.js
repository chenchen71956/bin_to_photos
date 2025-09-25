"use strict";

const WebSocket = require("ws");
const { generateEcho } = require("./utils");

const pendingEchoMap = new Map();

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

module.exports = { callApi, sendGroup };


