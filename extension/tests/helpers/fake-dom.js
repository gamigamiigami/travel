/**
 * content.js を実際に動かすための最小限のブラウザ環境。
 *
 * 構文チェックだけでは「宣言し忘れた変数」のような実行時エラーを見つけられない。
 * 本物のページに入れる前に、ここで一度走らせて確かめる。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeElement {
  constructor({ tag = 'div', className = '', id = '', role = '', text = '', attrs = {}, visible = true, children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.id = id;
    this.attrs = Object.assign({}, attrs);
    if (role) this.attrs.role = role;
    this.innerText = text;
    this.visible = visible;
    this.children = children;
    this.clicks = 0;
    this.parentElement = null;
    this.shadowRoot = null;
    for (const child of children) child.parentElement = this;
  }

  get textContent() {
    return this.innerText;
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  getClientRects() {
    return this.visible ? [{ width: 10, height: 10 }] : [];
  }

  click() {
    this.clicks += 1;
  }

  closest() {
    return null;
  }

  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  querySelectorAll(selector) {
    return matchAll(this.descendants(), selector);
  }
}

/** 使っているぶんだけのセレクタ解釈。完全な CSS ではない。 */
function matches(element, selector) {
  const part = selector.trim();
  let m;
  if ((m = part.match(/^\[class\*=['"]?([^'"\]]+)['"]?\]$/))) {
    return String(element.className).includes(m[1]);
  }
  if ((m = part.match(/^\[id\*=['"]?([^'"\]]+)['"]?\]$/))) {
    return String(element.id).includes(m[1]);
  }
  if ((m = part.match(/^\[([a-zA-Z-]+)\*=['"]?([^'"\]]+)['"]?\]$/))) {
    return String(element.getAttribute(m[1]) || '').includes(m[2]);
  }
  if ((m = part.match(/^\[([a-zA-Z-]+)=['"]?([^'"\]]+)['"]?\]$/))) {
    return String(element.getAttribute(m[1]) || '') === m[2];
  }
  if ((m = part.match(/^\[([a-zA-Z-]+)\]$/))) {
    return element.getAttribute(m[1]) !== null;
  }
  if ((m = part.match(/^([a-zA-Z]+)\[([a-zA-Z-]+)\]$/))) {
    return element.tagName === m[1].toUpperCase() && element.getAttribute(m[2]) !== null;
  }
  if (part === '*') return true;
  if (/^[a-zA-Z]+$/.test(part)) return element.tagName === part.toUpperCase();
  return false;
}

function matchAll(elements, selector) {
  const parts = selector.split(',').map((s) => s.trim()).filter(Boolean);
  return elements.filter((element) => parts.some((part) => matches(element, part)));
}

/**
 * content.js を読み込んで走らせる。
 * 返り値の listeners に onMessage のハンドラが入る。
 */
function loadContentScript({ url = 'https://travel.yahoo.co.jp/', title = 'テスト', elements = [], settings = {}, runtimeAlive = true } = {}) {
  const root = new FakeElement({ tag: 'body', children: elements });
  const all = root.descendants();

  const sent = [];
  const listeners = [];
  const timers = [];
  const warnings = [];

  const defaults = {
    enabled: true,
    minAmount: 1000,
    maxAmount: 100000,
    amountsWhitelist: [1000, 2000, 3000, 5000],
    requireCountdown: true,
    maxTimeLimitMin: 180,
    minScorePage: 6,
    minScorePopup: 4,
    ignorePatterns: [],
    autoClaim: true,
    expandBadge: false,
  };
  const effective = Object.assign({}, defaults, settings);

  const document = {
    title,
    body: root,
    documentElement: root,
    querySelectorAll: (selector) => matchAll(all, selector),
  };

  const context = {
    console: { warn: (...a) => warnings.push(a.join(' ')), log() {}, error() {} },
    document,
    location: { href: url, hostname: new URL(url).hostname, ancestorOrigins: [] },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        context.__observer = this;
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    Event: class {},
    KeyboardEvent: class {},
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms: ms || 0, cancelled: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].cancelled = true;
    },
    Promise,
    URL,
    Set,
    Map,
    Math,
    Date,
    JSON,
    Object,
    Array,
    Number,
    String,
    RegExp,
    chrome: {
      runtime: {
        id: runtimeAlive ? 'testextension' : undefined,
        sendMessage(message) {
          sent.push(message);
          if (message.type === 'getSettings') {
            return Promise.resolve({ settings: effective });
          }
          return Promise.resolve(null);
        },
        onMessage: {
          addListener: (fn) => listeners.push(fn),
        },
      },
    },
  };
  context.window = context;
  context.window.top = context;
  context.globalThis = context;
  context.window.HTMLInputElement = { prototype: {} };

  vm.createContext(context);
  const dir = path.join(__dirname, '..', '..', 'src');
  for (const file of ['detector.js', 'messaging.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), context, { filename: file });
  }

  /** 指定ミリ秒までに予約されたタイマーを実行する。 */
  function runTimers(upTo = 100000) {
    for (const timer of timers) {
      if (timer.cancelled || timer.ms > upTo) continue;
      timer.cancelled = true;
      timer.fn();
    }
  }

  /** start() の非同期処理（設定の取得）が終わるのを待つ。 */
  async function ready() {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return { context, sent, listeners, timers, warnings, runTimers, ready, root };
}

module.exports = { FakeElement, loadContentScript, matchAll };
