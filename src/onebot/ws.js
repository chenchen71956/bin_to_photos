"use strict";

const WebSocket = require("ws");
const { ACCESS_TOKEN, WS_URL } = require("./config");

function createWsClient(onOpen, onMessage, onClose, onError) {
  const headers = {};
  if (ACCESS_TOKEN && ACCESS_TOKEN.trim().length > 0) {
    headers["Authorization"] = `Bearer ${ACCESS_TOKEN}`;
  }
  const ws = new WebSocket(WS_URL, { headers });
  if (onOpen) ws.on("open", onOpen);
  if (onMessage) ws.on("message", onMessage);
  if (onClose) ws.on("close", onClose);
  if (onError) ws.on("error", onError);
  return ws;
}

module.exports = { createWsClient };


