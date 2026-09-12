/**
 * 预加载垫片：让 `node web-ui.js` 在本机（仓库根 type:module）也能按 CommonJS 跑。
 *
 * 原理：用 `--require` 预加载本文件，劫持 Module._extensions['.js']，
 * 对 docker/eftik-cloud/ 目录下的文件强制按 CommonJS 编译。
 * 容器内 /opt/gw 无 package.json，本来就是 CJS，因此该垫片只服务本地测试。
 *
 * 用法：NODE_OPTIONS="--require <abs path>/.cjs-preload.cjs" node web-ui.js
 */
"use strict";

const Module = require("module");
const fs = require("fs");
const path = require("path");

const originalJsHandler = Module._extensions[".js"];
const DIR = __dirname;

Module._extensions[".js"] = function (module, filename) {
  // 只对本目录（docker/eftik-cloud）下的文件强制 CJS；其余保持默认行为
  if (path.dirname(filename) === DIR) {
    const content = fs.readFileSync(filename, "utf8");
    module._compile(content, filename);
    return;
  }
  return originalJsHandler(module, filename);
};
