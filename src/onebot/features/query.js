"use strict";

const { buildRequestUrl, httpGetJson, httpGetBuffer } = require("../../check");
const { getBinPhotos } = require("../../db");
const { normalizeUrlForDedupe } = require("../utils");
const { callApi } = require("../sender");

async function handleBinQuery(ws, event) {
  const rawText = getPlain(event);
  const match = /^\s*bin\s+(\d+)\s*$/i.exec(rawText);
  if (!match) return false;
  const bin = match[1];
  const url = buildRequestUrl(bin);
  let replyText;
  let imageBase64List = [];
  try {
    const [remote] = await Promise.all([ httpGetJson(url) ]);
    replyText = formatBinReply(remote, bin);
    let photoUrls = getBinPhotos(bin);
    if (photoUrls && photoUrls.length > 0) {
      const seen = new Map();
      const deduped = [];
      for (const u of photoUrls) {
        const key = normalizeUrlForDedupe(u);
        if (seen.has(key)) continue; seen.set(key, true); deduped.push(u);
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
  return true;
}

function getPlain(event) {
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

function formatBinReply(result, requestedBin) {
  const empty = "---";
  const data = (result && typeof result === "object") ? result : {};
  const v = (key) => { const val = data[key]; if (val === undefined || val === null) return empty; if (typeof val === "string" && val.trim() === "") return empty; return String(val); };
  const valueOr = (value) => { if (value === undefined || value === null) return empty; if (typeof value === "string" && value.trim() === "") return empty; return String(value); };
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

module.exports = { handleBinQuery };


