#!/usr/bin/env node
"use strict";

const { buildRequestUrl, httpGetJson } = require("./check");
require("dotenv").config();
const { createWsClient } = require("./onebot");
const { initDb } = require("./db");

// 查询逻辑已迁移至 ./check

async function main() {
  const args = process.argv.slice(2);
  // 支持 --db=PATH 指定数据库路径
  const dbArg = args.find((a) => /^--db=/.test(a));
  const dbPath = dbArg ? dbArg.replace(/^--db=/, "") : undefined;
  const arg0 = args.find((a) => !/^--db=/.test(a));
  if (arg0 === "onebot") {
    try {
      const ok = initDb(dbPath);
      if (!ok) {
        console.warn("[DB] 未安装 better-sqlite3，数据库功能将禁用。");
      }
    } catch (e) {
      console.warn("[DB] 初始化失败：", e && e.message ? e.message : e);
    }
    createWsClient();
    return; // 常驻监听，不退出
  }

  const argBin = arg0; // 兼容旧用法：直接传入 bin
  const envBin = process.env.BIN;
  const bin = argBin || envBin;

  if (!bin) {
    console.error("用法: bincheck <bin>  或 设置环境变量 BIN=xxxx；或 npm start 启动 OneBot 监听");
    process.exit(1);
  }

  const url = buildRequestUrl(bin);
  try {
    const result = await httpGetJson(url);
    if (typeof result === "string") {
      console.log(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error("请求失败:", err.message || err);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildRequestUrl, httpGetJson };


