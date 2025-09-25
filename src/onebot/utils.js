"use strict";

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

function extractReplyTargetMessageId(event) {
  try {
    if (event.reply && (event.reply.message_id || event.reply.messageId)) {
      return event.reply.message_id || event.reply.messageId;
    }
  } catch {}
  try {
    if (Array.isArray(event.message)) {
      const seg = event.message.find((s) => s && s.type === "reply" && s.data && (s.data.id || s.data.message_id));
      if (seg) return seg.data.id || seg.data.message_id;
    }
  } catch {}
  return null;
}

function normalizeUrlForDedupe(u) {
  try {
    const url = new URL(String(u));
    const proto = (url.protocol || '').toLowerCase();
    const host = (url.host || '').toLowerCase();
    const path = url.pathname || '';
    return `${proto}//${host}${path}`;
  } catch {
    return String(u).trim().toLowerCase();
  }
}

module.exports = { generateEcho, getMessagePlainText, extractReplyTargetMessageId, normalizeUrlForDedupe };


