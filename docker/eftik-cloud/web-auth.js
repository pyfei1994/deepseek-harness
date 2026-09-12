/**
 * web-auth.js — 工作台 Web 端会话鉴权（替代浏览器原生 Basic Auth 弹框）
 *
 * 背景：原先直接用 HTTP Basic Auth，浏览器会弹一个无法自定义样式的原生对话框，
 * 与小程序的 /_eftik/api 通道共用同一个公网域名，因此鉴权必须同时支持三种调用方：
 *
 *   1. 浏览器         → 登录页 + 签名 Cookie（本模块新增，可自定义 UI）
 *   2. 小程序/脚本    → 保留 Basic Auth（Authorization: Basic ...），行为不变
 *   3. 容器内其它进程 → 走 /_eftik/api 前缀，不经过本模块（由 web-ui.js 直接转发）
 *
 * Cookie 设计：
 *   - 名称 eftik-session（与上游 dsh 自己的 dsh-auth-* 严格区分，避免互相干扰）
 *   - 值为 HMAC-SHA256(secret, "exp=<毫秒时间戳>")，只签名不加密（里面没有敏感信息）
 *   - HttpOnly + SameSite=Lax；有 TLS 时加 Secure
 *   - 签名密钥派生自密码哈希：改密码即自动失效所有旧会话（这是想要的行为）
 *
 * 依赖注入：本模块不直接读文件/环境，全部由 createWebAuth({...}) 传入，
 * 便于在网关进程里复用同一份密码文件与路径配置。
 */
"use strict";

const crypto = require("crypto");

const COOKIE_NAME = "eftik-session";
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/* ---------- 小工具 ---------- */

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

/** 恒定时间字符串比较，避免时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 从 Cookie 头里取指定 cookie（不解析其它字段，够用且无依赖） */
function readCookie(req, name) {
  const raw = String((req.headers && req.headers.cookie) || "");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function serializeCookie(name, value, opts) {
  const o = opts || {};
  let out = `${name}=${value}`;
  out += `; Path=${o.path || "/"}`;
  if (o.maxAge !== undefined) out += `; Max-Age=${Math.floor(o.maxAge)}`;
  if (o.httpOnly !== false) out += "; HttpOnly";
  if (o.secure) out += "; Secure";
  out += `; SameSite=${o.sameSite || "Lax"}`;
  return out;
}

/* ---------- 工厂 ---------- */

/**
 * @param {object} cfg
 * @param {string} cfg.passwordPath   sha256(密码) 的 hex 落盘路径
 * @param {number} [cfg.ttlMs]        Cookie 有效期，默认 30 天
 * @param {string[]} [cfg.browserHints] 判定「这是浏览器」的 Accept 特征
 * @returns {{ verifyBrowser, verifyBasic, login, logout, issueCookie, clearCookie, isConfigured, isBrowserRequest, passwordMatches }}
 */
function createWebAuth(cfg) {
  const fs = cfg.fs || require("fs");
  const passwordPath = cfg.passwordPath;
  const ttlMs = Number(cfg.ttlMs) > 0 ? Number(cfg.ttlMs) : DEFAULT_TTL_MS;

  /** 读取当前密码哈希；未设置返回空串 */
  function storedHash() {
    try {
      return String(fs.readFileSync(passwordPath, "utf8")).trim();
    } catch {
      return "";
    }
  }

  function isConfigured() {
    return storedHash().length > 0;
  }

  /** 签名密钥：派生自密码哈希 → 改密码会使所有既有会话立即失效 */
  function secret() {
    const h = storedHash();
    if (!h) return "";
    return crypto.createHmac("sha256", "eftik-web-session").update(h).digest();
  }

  /** 生成 cookie 值：exp=<毫秒>.<hex签名> */
  function sign(exp) {
    const key = secret();
    if (!key) return "";
    const payload = `exp=${exp}`;
    const sig = crypto.createHmac("sha256", key).update(payload).digest("hex");
    return `${Buffer.from(payload).toString("base64url")}.${sig}`;
  }

  /** 校验 cookie 值：签名正确且未过期 */
  function verifyToken(token) {
    const key = secret();
    if (!key || !token || typeof token !== "string") return false;
    const dot = token.indexOf(".");
    if (dot <= 0) return false;
    let payload;
    try {
      payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
    } catch {
      return false;
    }
    const expect = crypto.createHmac("sha256", key).update(payload).digest("hex");
    if (!safeEqual(expect, token.slice(dot + 1))) return false;
    const m = /^exp=(\d+)$/.exec(payload);
    if (!m) return false;
    return Number(m[1]) > Date.now();
  }

  /** 密码是否匹配（password 为明文） */
  function passwordMatches(password) {
    const expected = storedHash();
    if (!expected) return false;
    return safeEqual(expected, sha256Hex(password));
  }

  /** 浏览器会话是否有效 */
  function verifyBrowser(req) {
    return verifyToken(readCookie(req, COOKIE_NAME));
  }

  /** Basic Auth（兼容小程序 / 脚本 / curl） */
  function verifyBasic(req) {
    const raw = String((req.headers && req.headers.authorization) || "");
    if (!raw.startsWith("Basic ")) return false;
    let password = "";
    try {
      password = Buffer.from(raw.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
    } catch {
      return false;
    }
    return passwordMatches(password);
  }

  /** 任意一种凭据通过即可 */
  function verifyAny(req) {
    return verifyBrowser(req) || verifyBasic(req);
  }

  /**
   * 判断「这是浏览器请求」——只影响失败时的响应形态：
   *   浏览器   → 302 跳登录页 / 或返回登录页 HTML
   *   非浏览器 → 401 + WWW-Authenticate（保持既有契约，避免破坏自动化调用）
   *
   * 依据：浏览器导航请求必然带 text/html 的 Accept，且通常带 Sec-Fetch-* 头。
   * WebSocket 升级请求不带 Accept，用 Upgrade 头单独识别。
   */
  function isBrowserRequest(req) {
    const h = req.headers || {};
    if (h.upgrade && String(h.upgrade).toLowerCase() === "websocket") {
      // WS 无法跟随重定向，交给调用方按导航请求同等方式处理（返回 401 或拒绝升级）
      return false;
    }
    const accept = String(h.accept || "");
    if (/text\/html/.test(accept)) return true;
    // 部分 XHR/fetch 场景不带 text/html，但带 Sec-Fetch-Mode: navigate（顶层导航）
    return String(h["sec-fetch-mode"] || "").toLowerCase() === "navigate";
  }

  /** 登录成功后返回 Set-Cookie 值 */
  function issueCookie(remember) {
    const exp = Date.now() + (remember === false ? 12 * 60 * 60 * 1000 : ttlMs); // 不勾选则 12 小时
    const token = sign(exp);
    if (!token) return null;
    return serializeCookie(COOKIE_NAME, token, {
      maxAge: Math.max(1, Math.floor((exp - Date.now()) / 1000)),
      httpOnly: true,
      sameSite: "Lax",
    });
  }

  /** 登出：让浏览器立刻丢弃 cookie */
  function clearCookie() {
    return serializeCookie(COOKIE_NAME, "", { maxAge: 0, httpOnly: true, sameSite: "Lax" });
  }

  return {
    COOKIE_NAME,
    isConfigured,
    passwordMatches,
    verifyBrowser,
    verifyBasic,
    verifyAny,
    isBrowserRequest,
    issueCookie,
    clearCookie,
  };
}

module.exports = { createWebAuth, COOKIE_NAME, sha256Hex, readCookie, safeEqual };
