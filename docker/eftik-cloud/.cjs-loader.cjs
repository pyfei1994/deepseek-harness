/**
 * 本地测试用的 CJS 加载器。
 *
 * 背景：仓库根的 package.json 有 `"type": "module"`，因此 `docker/eftik-cloud/web-auth.js`
 * 在本机直接 `require()` 时会被 Node 当成 ESM，报 `require is not defined`。
 * 但在容器里 `/opt/gw/` 没有 package.json，同一个文件就是普通 CommonJS —— 生产没问题。
 *
 * 为了不改生产文件名（改成 .cjs 会让 Dockerfile / require 路径都要跟着动，收益为零），
 * 这里用 Module._compile 显式按 CommonJS 编译目标文件，绕开扩展名推断。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

/** 以 CommonJS 语义加载一个 .js 文件并返回其 module.exports */
function loadCjs(file) {
  const full = path.isAbsolute(file) ? file : path.join(__dirname, file);
  const src = fs.readFileSync(full, "utf8");
  const m = new Module(full);
  m.filename = full;
  m.paths = Module._nodeModulePaths(path.dirname(full));
  m._compile(src, full);
  return m.exports;
}

module.exports = { loadCjs };
