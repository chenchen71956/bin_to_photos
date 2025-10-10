#!/usr/bin/env node
"use strict";

require("dotenv").config();
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { buildRequestUrl, httpGetJson, httpGetBuffer } = require("../check");
const { getBinPhotos, initDb, hasIssue, insertIssueIfNew, getAllVotedUrls } = require("../db");
const { listAllOpenIssues, parseBinAndUrlsFromText } = require("../github");
const { setSender } = require("./notifier");
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

function estimateTextWidthPx(text, fontSize) {
  const s = String(text || "");
  let em = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
    if (ch === " ") { em += 0.5; continue; }
    if (",.;:!iI|l'`".includes(ch)) { em += 0.45; continue; }
    if (code >= 0x3000) { em += 1.0; continue; }
    em += 0.6;
  }
  return Math.round(em * fontSize);
}

function buildInfoMarkup(data, requestedBin) {
  const escText = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const empty = "---";
  const v = (key) => {
    const val = data && data[key];
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
    `BIN：${valueOr((data && data.bin) || requestedBin)}`,
    `品牌：${v("brand")}`,
    `類型：${v("type")}`,
    `卡片等級：${v("category")}`,
    `發卡行：${v("issuer")}`,
    `國家：${v("country")}`,
    `發卡行電話：${v("issuerPhone")}`,
    `發卡行網址：${v("issuerUrl")}`,
  ];
  const padding = 28;
  const titleSize = 28;
  const lineSize = 20;
  const lineGap = 10;
  const titleGap = 16;
  const totalHeight = padding + titleSize + titleGap + lines.length * (lineSize + lineGap) - lineGap + padding;
  const title = `BIN 資訊`;
  const fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, "PingFang SC", "Noto Sans CJK SC", "Microsoft Yahei", Arial, sans-serif';
  const titleW = estimateTextWidthPx(title, titleSize);
  let maxLineW = titleW;
  for (const line of lines) {
    const w = estimateTextWidthPx(line, lineSize);
    if (w > maxLineW) maxLineW = w;
  }
  const minWidth = 480;
  const maxWidth = 1000;
  const width = Math.max(minWidth, Math.min(maxWidth, padding * 2 + maxLineW));
  let y = padding;
  const x = padding;
  const tEl = (x1, y1, size, text) => `<text x="${x1}" y="${y1}" font-size="${size}" font-family="${escAttr(fontFamily)}" fill="#111">${escText(text)}</text>`;
  const out = [];
  out.push(tEl(x, y + titleSize, titleSize, title));
  y += titleSize + titleGap;
  for (const line of lines) {
    out.push(tEl(x, y + lineSize, lineSize, line));
    y += lineSize + lineGap;
  }
  const markup = `<?xml version="1.0" encoding="UTF-8"?>\n` +
`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">` +
`<rect x="0" y="0" width="${width}" height="${totalHeight}" fill="#ffffff"/>` +
out.join("") +
`</svg>`;
  return { markup, width, height: totalHeight };
}

function pickBrandAsset(brandRaw) {
  try {
    const s = String(brandRaw || "").toUpperCase().replace(/\s+/g, "");
    const base = path.join(__dirname, "..", "..", "assets");
    if (!s) return null;
    if (s.includes("UNIONPAY") || s.includes("CHINAUNIONPAY") || s.includes("CUP") || s.includes("CHINAUNIONPAY")) {
      return path.join(base, "unionpay.svg");
    }
    if (s.includes("VISA")) {
      return path.join(base, "visa.svg");
    }
    if (s.includes("MASTERCARD") || s.includes("MASTERCard")) {
      return path.join(base, "mastercard.svg");
    }
    if (s.includes("JCB")) {
      return path.join(base, "jcb.svg");
    }
    if (s.includes("AMERICANEXPRESS") || s.includes("AMEX")) {
      return path.join(base, "american_express.svg");
    }
  } catch {}
  return null;
}

async function renderInfoImageBuffers(data, bin) {
  try {
    let sharpLib = null;
    try { sharpLib = require("sharp"); } catch (e) {
      try { console.warn(`[BIN][info] 未加载到 sharp: ${e && e.message ? e.message : e}`); } catch {}
    }
    if (!sharpLib) {
      try { console.warn("[BIN][info] 缺少 sharp，跳过信息图渲染"); } catch {}
      return { pngBase64: null, jpgBase64: null, pngSavedPath: null, jpgSavedPath: null };
    }
    const { markup, width, height } = buildInfoMarkup(data, bin);
    const density = Math.max(72, Number(process.env.SVG_DENSITY || 192));
    const tmpDir = path.join(__dirname, "..", "..", ".tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    let pngBase64 = null, jpgBase64 = null, pngSavedPath = null, jpgSavedPath = null;
    try {
      // 先渲染纯文本底图 PNG
      let basePng = await sharpLib(Buffer.from(markup, "utf8"), { density }).png({ compressionLevel: 9 }).toBuffer();
      // 叠加品牌水印（如有）
      try {
        const brandAsset = pickBrandAsset(data && data.brand);
        if (brandAsset && fs.existsSync(brandAsset)) {
          const baseMeta = await sharpLib(basePng).metadata();
          const canvasW = baseMeta.width || width || 800;
          const canvasH = baseMeta.height || height || 400;
          const svgBuf = fs.readFileSync(brandAsset);
          // 将 SVG 渲染为透明 PNG，并按宽度 60% 进行缩放
          const logoPng = await sharpLib(svgBuf, { density }).resize(Math.max(1, Math.round(canvasW * 0.6))).png().toBuffer();
          const logoMeta = await sharpLib(logoPng).metadata();
          const overlay = await sharpLib(logoPng).ensureAlpha().modulate({ opacity: 0.08 }).toBuffer();
          const left = Math.max(0, Math.round(((canvasW) - (logoMeta.width || 0)) / 2));
          const top = Math.max(0, Math.round(((canvasH) - (logoMeta.height || 0)) / 2));
          basePng = await sharpLib(basePng).composite([{ input: overlay, left, top }]).png().toBuffer();
        }
      } catch (eW) {
        try { console.warn(`[BIN][info] 品牌水印叠加失败: ${eW && eW.message ? eW.message : eW}`); } catch {}
      }
      if (basePng && basePng.length > 0) {
        pngBase64 = basePng.toString("base64");
        try { pngSavedPath = path.join(tmpDir, `bin_${bin}_${Date.now()}_info.png`); fs.writeFileSync(pngSavedPath, basePng); } catch {}
        try { console.log(`[BIN][info] PNG 渲染成功 size=${basePng.length}B density=${density}`); } catch {}
      } else {
        try { console.warn("[BIN][info] PNG 渲染得到空缓冲"); } catch {}
      }
    } catch (e1) {
      try { console.warn(`[BIN][info] PNG 渲染失败: ${e1 && e1.message ? e1.message : e1}`); } catch {}
    }
    if (!pngBase64) {
      try {
        // 同样流程：生成 JPG，并叠加品牌水印
        let baseJpg = await sharpLib(Buffer.from(markup, "utf8"), { density }).jpeg({ quality: 90 }).toBuffer();
        try {
          const brandAsset = pickBrandAsset(data && data.brand);
          if (brandAsset && fs.existsSync(brandAsset)) {
            const baseMeta = await sharpLib(baseJpg).metadata();
            const canvasW = baseMeta.width || width || 800;
            const canvasH = baseMeta.height || height || 400;
            const svgBuf = fs.readFileSync(brandAsset);
            const logoPng = await sharpLib(svgBuf, { density }).resize(Math.max(1, Math.round(canvasW * 0.6))).png().toBuffer();
            const logoMeta = await sharpLib(logoPng).metadata();
            const overlay = await sharpLib(logoPng).ensureAlpha().modulate({ opacity: 0.08 }).toBuffer();
            const left = Math.max(0, Math.round(((canvasW) - (logoMeta.width || 0)) / 2));
            const top = Math.max(0, Math.round(((canvasH) - (logoMeta.height || 0)) / 2));
            baseJpg = await sharpLib(baseJpg).composite([{ input: overlay, left, top }]).jpeg({ quality: 90 }).toBuffer();
          }
        } catch (eW2) {
          try { console.warn(`[BIN][info] 品牌水印叠加失败(JPG): ${eW2 && eW2.message ? eW2.message : eW2}`); } catch {}
        }
        if (baseJpg && baseJpg.length > 0) {
          jpgBase64 = baseJpg.toString("base64");
          try { jpgSavedPath = path.join(tmpDir, `bin_${bin}_${Date.now()}_info.jpg`); fs.writeFileSync(jpgSavedPath, baseJpg); } catch {}
          try { console.log(`[BIN][info] JPG 渲染成功 size=${baseJpg.length}B density=${density}`); } catch {}
        } else {
          try { console.warn("[BIN][info] JPG 渲染得到空缓冲"); } catch {}
        }
      } catch (e2) {
        try { console.warn(`[BIN][info] JPG 渲染失败: ${e2 && e2.message ? e2.message : e2}`); } catch {}
      }
    }
    return { pngBase64, jpgBase64, pngSavedPath, jpgSavedPath };
  } catch {
    return { pngBase64: null, jpgBase64: null, pngSavedPath: null, jpgSavedPath: null };
  }
}

// 已移除 binsvg/SVG 渲染相关实现

async function handleTenCardMosaic(ws, event, mode) {
  try { console.log("[TenCard] 收到十卡图请求"); } catch {}
  const urls = (getAllVotedUrls() || []).slice(0); // 全库
  if (!urls.length) {
    const msg = "库内暂无卡面，先去上报吧～";
    const payload = event.message_type === "group"
      ? { message_type: "group", group_id: event.group_id, message: msg }
      : { message_type: "private", user_id: event.user_id, message: msg };
    await callApi(ws, "send_msg", payload, 15000);
    return;
  }

  // 下载所有图片（限并发），保持原分辨率，以最小缩放适配统一方格，拼接为正方形
  const maxTiles = 100; // 最多 10x10 张
  const slice = urls.slice(0, maxTiles);
  const concurrency = 3;
  const buffers = new Array(slice.length);
  let next = 0;
  async function fetchOne(i) {
    const u = slice[i];
    try {
      const buf = await httpGetBuffer(u);
      buffers[i] = buf && buf.length > 0 ? buf : null;
    } catch { buffers[i] = null; }
  }
  async function worker() {
    while (true) { const i = next++; if (i >= slice.length) break; await fetchOne(i); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));
  const valid = buffers.map((b, i) => ({ buf: b, url: slice[i] })).filter(x => x.buf && x.buf.length > 0);
  if (!valid.length) {
    const msg = "下载失败：暂无可用图片";
    const payload = event.message_type === "group"
      ? { message_type: "group", group_id: event.group_id, message: msg }
      : { message_type: "private", user_id: event.user_id, message: msg };
    await callApi(ws, "send_msg", payload, 15000);
    return;
  }

  // 两排紧凑排布：横卡在上、竖卡在下；不缩放不放大，图片之间无间隔
  const Jimp = require("jimp");
  const loaded = [];
  for (const v of valid) {
    try {
      const img = await Jimp.read(v.buf);
      loaded.push({ img, w: img.bitmap.width, h: img.bitmap.height });
    } catch {}
  }
  const horiz = loaded.filter(it => it.w >= it.h);
  const vert = loaded.filter(it => it.w < it.h);

  // 统一尺寸：按行分别统一高度（可通过环境变量调整）
  const targetTopH = Math.max(64, Number(process.env.TEN_CARD_TOP_H || 360));
  const targetBottomH = Math.max(64, Number(process.env.TEN_CARD_BOTTOM_H || 360));
  const resizedTop = [];
  const resizedBottom = [];
  for (const it of horiz) {
    const scale = targetTopH / it.h;
    const w = Math.max(1, Math.round(it.w * scale));
    const h = targetTopH;
    const clone = it.img.clone();
    clone.resize(w, h, Jimp.RESIZE_BILINEAR);
    resizedTop.push({ img: clone, w, h });
  }
  // 竖卡宽度对齐到“半张横卡”的宽度（用上排平均宽度作为单位宽）
  const unitW = resizedTop.length > 0 ? Math.max(1, Math.round(resizedTop.reduce((s, it) => s + it.w, 0) / resizedTop.length)) : null;
  for (const it of vert) {
    const clone = it.img.clone();
    if (unitW && it.w > 0) {
      const w = Math.max(1, Math.round(unitW / 2));
      const scale = w / it.w;
      const h = Math.max(1, Math.round(it.h * scale));
      clone.resize(w, h, Jimp.RESIZE_BILINEAR);
      resizedBottom.push({ img: clone, w, h });
    } else {
      // 无横卡可参考时，退回到底行统一高度方案
      const scale = targetBottomH / it.h;
      const w = Math.max(1, Math.round(it.w * scale));
      const h = targetBottomH;
      clone.resize(w, h, Jimp.RESIZE_BILINEAR);
      resizedBottom.push({ img: clone, w, h });
    }
  }
  // 目标宽度取总面积的平方根，尽量接近正方形；且不小于单张最大宽
  const allForArea = [...resizedTop, ...resizedBottom];
  const totalArea = allForArea.reduce((s, it) => s + (it.w * it.h), 0);
  let targetWidth = Math.max(1, Math.round(Math.sqrt(Math.max(1, totalArea))));
  const maxSingleW = allForArea.length ? Math.max(...allForArea.map(it => it.w)) : 1;
  targetWidth = Math.max(maxSingleW, targetWidth);

  function buildRows(list, limitW) {
    const rows = [];
    let cur = [];
    let w = 0;
    let h = 0;
    for (const it of list) {
      if (cur.length > 0 && (w + it.w) > limitW) {
        rows.push({ items: cur, width: w, height: h });
        cur = [];
        w = 0;
        h = 0;
      }
      cur.push(it);
      w += it.w;
      h = Math.max(h, it.h);
    }
    if (cur.length) rows.push({ items: cur, width: w, height: h });
    return rows;
  }

  const rowsTop = buildRows(resizedTop, targetWidth);
  const rowsBottom = buildRows(resizedBottom, targetWidth);
  const rows = [...rowsTop, ...rowsBottom];
  const mosaicW = Math.max(1, rows.length ? Math.max(...rows.map(r => r.width)) : 1);
  const mosaicH = rows.reduce((s, r) => s + r.height, 0);

  const canvas = await new Jimp(mosaicW, Math.max(1, mosaicH), 0xffffffff);

  // 绘制所有行（横排优先，竖排随后），达到接近正方形的效果
  let y = 0;
  for (const row of rows) {
    let x = 0;
    for (const it of row.items) {
      canvas.composite(it.img, x, y);
      x += it.w;
    }
    y += row.height;
  }

  const outBuf = await canvas.getBufferAsync(Jimp.MIME_PNG);
  // 保存到 .tmp 目录
  try {
    const tmpDir = path.join(__dirname, "..", "..", ".tmp");
    if (!fs.existsSync(tmpDir)) { fs.mkdirSync(tmpDir, { recursive: true }); }
    const file = path.join(tmpDir, `ten_card_${Date.now()}.png`);
    fs.writeFileSync(file, outBuf);
    try { console.log(`[TenCard] 已保存: ${file}`); } catch {}
  } catch (e) {
    try { console.warn(`[TenCard] 保存到 .tmp 失败: ${e && e.message ? e.message : e}`); } catch {}
  }
  const b64 = outBuf.toString("base64");
  const imageSeg = [{ type: "image", data: { file: `base64://${b64}` } }];
  const payload = event.message_type === "group"
    ? { message_type: "group", group_id: event.group_id, message: imageSeg }
    : { message_type: "private", user_id: event.user_id, message: imageSeg };
  await callApi(ws, "send_msg", payload, 30000);
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
  // 已移除 binsvg 命令
  // 十卡图 / 百卡图 / 万卡图：输出库内所有卡面，近正方形拼接
  if (/^\s*(?:十卡图|10卡图|十卡|十图)\s*$/i.test(rawText)) {
    await handleTenCardMosaic(ws, event, "all");
    return;
  }
  if (/^\s*(?:百卡图|100卡图|百卡)\s*$/i.test(rawText)) {
    await handleTenCardMosaic(ws, event, "all");
    return;
  }
  if (/^\s*(?:万卡图|10000卡图|万卡)\s*$/i.test(rawText)) {
    await handleTenCardMosaic(ws, event, "all");
    return;
  }
  // 支持大小写、不带空格以及多种分隔符；提取后续所有连续数字
  const match = /^\s*bin[\s:：=,\-]*([0-9]+)/i.exec(rawText);
  if (!match) return;
  const digits = match[1];
  if (digits.length < 6) return; // 小于六位忽略
  const bin = digits.slice(0, 6); // 多于六位仅取前六位
  const url = buildRequestUrl(bin);

  try {
    console.log(`[BIN] 收到查询: bin=${bin}, from=${event.message_type === "group" ? `group:${event.group_id}` : `user:${event.user_id}`}`);
  } catch {}

  let replyText;
  let imageBase64List = [];
  let infoPngBase64 = null, infoJpgBase64 = null, infoPngSavedPath = null, infoJpgSavedPath = null;
  try {
    const tRemote = Date.now();
    const [remote] = await Promise.all([
      httpGetJson(url),
    ]);
    try { console.log(`[BIN] 远端BIN接口完成: ${Date.now() - tRemote}ms`); } catch {}
    replyText = formatBinReply(remote, bin);

    // 防打扰：查不到品牌则不回复（群聊与私聊都不回）
    try {
      const brandRaw = String(remote && remote.brand != null ? remote.brand : "").trim();
      if (!brandRaw) {
        console.log(`[BIN] 品牌为空，不回复 bin=${bin}`);
        return; // 直接结束，不再继续下载图片与发送
      }
    } catch {}

    // 地区黑名单拦截：MACAU / HONG KONG / TAIWAN
    try {
      const countryRaw = String(remote && remote.country ? remote.country : "").toUpperCase();
      const normalized = countryRaw.replace(/\s+/g, "");
      const blocked = normalized === "MACAU" || normalized === "HONGKONG" || normalized.includes("TAIWAN");
      if (blocked) {
        console.warn(`[BIN] 命中地区黑名单: country=${countryRaw}`);
        replyText = "此BIN的发卡地被禁止！";
        const segments = [{ type: "text", data: { text: replyText } }];
        if (event.message_type === "private") {
          await callApi(ws, "send_msg", { message_type: "private", user_id: event.user_id, message: segments }, 15000);
        } else if (event.message_type === "group") {
          await callApi(ws, "send_msg", { message_type: "group", group_id: event.group_id, message: segments }, 15000);
        }
        return;
      }
    } catch {}

    // 渲染 BIN 信息图（PNG 优先，失败则 JPG），用于替代文本描述
    try {
      const r = await renderInfoImageBuffers(remote, bin);
      infoPngBase64 = r.pngBase64; infoJpgBase64 = r.jpgBase64;
      infoPngSavedPath = r.pngSavedPath; infoJpgSavedPath = r.jpgSavedPath;
      try { console.log(`[BIN] 信息图渲染结果: png=${!!infoPngBase64} jpg=${!!infoJpgBase64} path=${infoPngSavedPath || infoJpgSavedPath || "-"}`); } catch {}
    } catch (e) {
      try { console.warn(`[BIN] 信息图渲染异常: ${e && e.message ? e.message : e}`); } catch {}
    }

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

  const segments = [];
  // 先附上信息图
  if (infoPngBase64) {
    segments.push({ type: "image", data: { file: `base64://${infoPngBase64}` } });
  } else if (infoJpgBase64) {
    segments.push({ type: "image", data: { file: `base64://${infoJpgBase64}` } });
  } else if (infoPngSavedPath || infoJpgSavedPath) {
    const p = infoPngSavedPath || infoJpgSavedPath;
    segments.push({ type: "text", data: { text: `信息图已保存：${p}` } });
  }
  for (const base64 of imageBase64List) {
    segments.push({ type: "image", data: { file: `base64://${base64}` } });
  }
  // 若既无信息图也无卡面，则回退发送文本 BIN 信息
  if (segments.length === 0) {
    segments.push({ type: "text", data: { text: replyText } });
  }

  try { console.log(`[BIN] 准备发送: images=${imageBase64List.length}, text_len=${(replyText || "").length}`); } catch {}
  const sendPayloadPrivate = { message_type: "private", user_id: event.user_id, message: segments };
  const sendPayloadGroup = { message_type: "group", group_id: event.group_id, message: segments };
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
      // 文本回退：至少发送 BIN 文本信息
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
  // 提供一个统一 sender 给通知模块，避免循环依赖
  setSender(async (groupId, message, timeoutMs) => {
    const payload = { message_type: "group", group_id: groupId, message };
    await callApi(ws, "send_msg", payload, timeoutMs || 15000);
  });

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
// notifyNewBinInserted 已迁移到 notifier，避免循环依赖


