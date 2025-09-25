#!/usr/bin/env node
"use strict";

const { createWsClient } = require("./app");

function main() {
  createWsClient();
}

if (require.main === module) {
  main();
}

module.exports = { main };


