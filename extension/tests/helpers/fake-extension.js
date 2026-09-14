/**
 * background.js（service worker）と設定画面・popup を実際に走らせるための環境。
 *
 * 構文チェックでは「宣言し忘れた変数」「HTML に無い id を掴もうとしている」
 * といった実行時の失敗を見つけられない。読み込んで動かして確かめる。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src');

function makeStorage() {
  const data = {};
  return {
    data,
    local: {
      get(keys) {
        if (typeof keys === 'string') return Promise.resolve({ [keys]: data[keys] });
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) out[key] = data[key];
          return Promise.resolve(out);
        }
        return Promise.resolve(Object.assign({}, data));
      },
      set(patch) {
        Object.assign(data, patch);
        return Promise.resolve();
      },
      remove(key) {
        delete data[key];
        return Promise.resolve();
      },
    },
  };
}

/** background.js を走らせる。 */
function loadBackground() {
  const storage = makeStorage();
  const listeners = { message: [], alarm: [], installed: [], startup: [], notificationClick: [] };
  const calls = { notifications: [], fetches: [], tabs: [], alarms: [] };
  const errors = [];

  const context = {
    console: { warn() {}, log() {}, error: (...a) => errors.push(a.join(' ')) },
    setTimeout: (fn) => { void fn; return 1; },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    Promise, URL, Set, Map, Math, Date, JSON, Object, Array, Number, String, RegExp, Error,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/120 Edg/120' },
    fetch: (url, init) => {
      calls.fetches.push({ url, init });
      return Promise.resolve({ ok: true, status: 200 });
    },
    importScripts(...files) {
      for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
      }
    },
    chrome: {
      runtime: {
        id: 'testextension',
        getManifest: () => ({ version: '0.0.0-test' }),
        getPlatformInfo: () => Promise.resolve({ os: 'win' }),
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
        onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      },
      storage,
      alarms: {
        clear: () => Promise.resolve(),
        create: (name, opts) => { calls.alarms.push({ name, opts }); return Promise.resolve(); },
        onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
      },
      notifications: {
        create: (id, options) => { calls.notifications.push({ id, options }); return Promise.resolve(id); },
        clear: () => Promise.resolve(),
        onClicked: { addListener: (fn) => listeners.notificationClick.push(fn) },
      },
      tabs: {
        create: (opts) => { calls.tabs.push(opts); return Promise.resolve({ id: 1, windowId: 1 }); },
        update: () => Promise.resolve({ id: 1 }),
        remove: () => Promise.resolve(),
        get: () => Promise.resolve({ id: 1, url: 'https://travel.yahoo.co.jp/' }),
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(null),
        onUpdated: { addListener() {}, removeListener() {} },
      },
      windows: { update: () => Promise.resolve() },
      scripting: { executeScript: () => Promise.resolve([]) },
    },
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), context, {
    filename: 'background.js',
  });

  /** onMessage に投げる。 */
  function post(message) {
    return new Promise((resolve) => {
      let done = false;
      for (const listener of listeners.message) {
        const kept = listener(message, {}, (response) => {
          done = true;
          resolve(response);
        });
        // true を返さなかった＝返事をしない種類のメッセージ。待たない。
        if (!kept) {
          if (!done) resolve(null);
        } else {
          setTimeout(() => {
            if (!done) resolve(null);
          }, 60);
        }
      }
      if (!listeners.message.length) resolve(null);
    });
  }

  async function settle() {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  }

  return { context, storage, listeners, calls, errors, post, settle };
}

/**
 * 設定画面 / popup を走らせる。
 * HTML から id を拾って要素を用意するので、JS と HTML の食い違いが分かる。
 */
function loadPage(htmlFile, jsFiles) {
  const html = fs.readFileSync(path.join(SRC, htmlFile), 'utf8');
  const ids = new Set();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]);

  const warnings = [];
  const elements = {};
  const domReady = [];

  for (const id of ids) {
    elements[id] = {
      id,
      type: html.includes(`id="${id}"`) && /type="checkbox"[^>]*id="` + id + `"|id="${id}"[^>]*type="checkbox"/.test(html) ? 'checkbox' : 'text',
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      disabled: false,
      style: {},
      className: '',
      listeners: {},
      addEventListener(event, fn) { (this.listeners[event] = this.listeners[event] || []).push(fn); },
    };
  }

  const context = {
    console: { warn: (...a) => warnings.push(a.join(' ')), log() {}, error: (...a) => warnings.push(a.join(' ')) },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    Promise, URL, Set, Map, Math, Date, JSON, Object, Array, Number, String, RegExp, Error,
    Blob: class {},
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'Chrome/120' },
    document: {
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => Object.values(elements),
      createElement: () => ({ click() {}, setAttribute() {} }),
      addEventListener: (event, fn) => { if (event === 'DOMContentLoaded') domReady.push(fn); },
    },
    chrome: {
      runtime: {
        id: 'testextension',
        getManifest: () => ({ version: '0.0.0-test' }),
        sendMessage: () => Promise.resolve({ ok: true }),
        openOptionsPage() {},
      },
      storage: makeStorage(),
      tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(null) },
      scripting: { executeScript: () => Promise.resolve([]) },
    },
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  for (const file of jsFiles) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
  }

  async function ready() {
    for (const fn of domReady) await fn();
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  }

  return { context, elements, ids, warnings, ready };
}

module.exports = { loadBackground, loadPage };
