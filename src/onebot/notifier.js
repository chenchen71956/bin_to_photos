"use strict";

const { buildRequestUrl, httpGetJson, httpGetBuffer } = require("../check");

let sendToGroupFn = null;

function setSender(fn) {
  sendToGroupFn = typeof fn === "function" ? fn : null;
}

async function notifyNewBinInserted(bin, pickedUrls) {
  if (!sendToGroupFn) return;
  const env = process.env.ADMIN_GROUP_IDS || process.env.ADMIN_GROUP_ID || "";
  const ids = String(env)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return;

  // 幂等防抖：仅首次成功打点后才继续通知
  try {
    const { tryMarkAdminNotified } = require("../db");
    const mark = tryMarkAdminNotified(bin);
    if (!mark || !mark.inserted) {
      try { console.log(`[Notifier] BIN ${bin} 已通知过，跳过`); } catch {}
      return;
    }
  } catch {}

  let remote = null;
  try { remote = await httpGetJson(buildRequestUrl(bin)); } catch {}
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

  async function withRetry(fn, attempts = 3) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try { return await fn(); }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, i * 300)); }
    }
    throw lastErr;
  }

  for (const gidRaw of ids) {
    const gid = /^-?\d+$/.test(gidRaw) ? Number(gidRaw) : gidRaw;
    try {
      await withRetry(() => sendToGroupFn(gid, text, 15000));
      for (const b64 of previewBase64List) {
        const imageSeg = [{ type: "image", data: { file: `base64://${b64}` } }];
        await withRetry(() => sendToGroupFn(gid, imageSeg, 30000));
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e) {
      try { console.warn(`[OneBot] 管理群通知失败 chat=${gid}:`, e && e.message ? e.message : e); } catch {}
    }
  }
}

module.exports = { setSender, notifyNewBinInserted };


