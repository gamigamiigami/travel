/**
 * 拡張機能の司令塔（service worker）。
 *
 *  - content script からのクーポン検出報告を受けて通知する
 *  - 一定間隔でバックグラウンドタブを開いて巡回する
 *  - 検出の有無にかかわらず結果を履歴に残す
 *
 * MV3 の service worker は放っておくと30秒で止まるので、巡回中は
 * keepAlive で API を叩き続けて生かしておく。
 */
importScripts('settings.js');

const ALARM_PATROL = 'patrol';
const PATROL_TAB_KEY = 'patrolTabId';
const NOTIFY_ICON = 'icons/icon128.png';

// ---------------------------------------------------------------- 小道具

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (value, ratio) => value * (1 - ratio + Math.random() * ratio * 2);
const todayKey = () => new Date().toISOString().slice(0, 10);

function startKeepAlive() {
  // API を呼ぶたびに service worker の停止タイマーがリセットされる。
  return setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sendToTab(tabId, message, timeoutMs = 8000) {
  // frameId: 0 でトップフレームだけに聞く。指定しないと iframe が先に
  // 「ヒット0件」と答えてしまい、履歴に誤った「検出なし」が残る。
  return withTimeout(
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null),
    timeoutMs,
    null
  );
}

function waitForLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish();
    }
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---------------------------------------------------------------- 履歴

async function recordHistory(entry) {
  const settings = await Settings.getSettings();
  if (!settings.historyEnabled) return;
  const stored = await chrome.storage.local.get('history');
  const history = stored.history || [];
  history.push(entry);
  const overflow = history.length - settings.historyMax;
  await chrome.storage.local.set({
    history: overflow > 0 ? history.slice(overflow) : history,
  });
}

async function bumpDailyCount() {
  const key = todayKey();
  const stored = await chrome.storage.local.get('daily');
  const daily = stored.daily && stored.daily.date === key
    ? stored.daily
    : { date: key, count: 0 };
  daily.count += 1;
  await chrome.storage.local.set({ daily });
  return daily.count;
}

async function dailyCount() {
  const stored = await chrome.storage.local.get('daily');
  return stored.daily && stored.daily.date === todayKey() ? stored.daily.count : 0;
}

// ---------------------------------------------------------------- 通知

function buildTitle(hit) {
  return `🎫 ${hit.amount.toLocaleString()}円OFFクーポン出現！`;
}

function buildBody(hit, context) {
  const lines = [`金額: ${hit.amount.toLocaleString()}円OFF`];
  if (hit.code) lines.push(`コード: ${hit.code}`);
  if (hit.timeLimitMin) lines.push(`有効時間: 約${hit.timeLimitMin}分`);
  if (context.claimed) lines.push('獲得ボタンを自動で押しました');
  lines.push(`検出元: ${hit.source} (score=${hit.score})`);
  if (hit.reasons && hit.reasons.length) lines.push(`根拠: ${hit.reasons.join('・')}`);
  lines.push(`ブラウザ: ${Settings.browserName(context.userAgent)}`);
  lines.push(`URL: ${context.pageUrl}`);
  return lines.join('\n');
}

async function sendNtfy(settings, title, body, clickUrl) {
  if (!settings.notifyNtfy || !settings.ntfyTopic) return false;
  // 日本語をHTTPヘッダに載せると送信自体が失敗するので、必ずJSON APIを使う。
  const response = await fetch(settings.ntfyServer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: settings.ntfyTopic,
      title,
      message: body,
      priority: Number(settings.ntfyPriority) || 5,
      tags: ['tickets'],
      click: clickUrl || 'https://travel.yahoo.co.jp/',
    }),
  });
  if (!response.ok) throw new Error('ntfy HTTP ' + response.status);
  return true;
}

async function sendDiscord(settings, title, body) {
  if (!settings.notifyDiscord || !settings.discordWebhookUrl) return false;
  const response = await fetch(settings.discordWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `🔔 **${title}**\n${body}`.slice(0, 1900) }),
  });
  if (!response.ok) throw new Error('Discord HTTP ' + response.status);
  return true;
}

async function sendDesktop(settings, title, body, clickUrl) {
  if (!settings.notifyDesktop) return false;
  const id = 'coupon-' + Date.now();
  await chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title,
    message: body.slice(0, 400),
    priority: 2,
    requireInteraction: true,
  });
  const links = (await chrome.storage.local.get('notificationLinks')).notificationLinks || {};
  links[id] = clickUrl;
  await chrome.storage.local.set({ notificationLinks: links });
  return true;
}

async function notify(settings, title, body, clickUrl) {
  const results = await Promise.allSettled([
    sendDesktop(settings, title, body, clickUrl),
    sendNtfy(settings, title, body, clickUrl),
    sendDiscord(settings, title, body),
  ]);
  const failures = results
    .filter((r) => r.status === 'rejected')
    .map((r) => String(r.reason));
  if (failures.length) console.warn('通知の一部が失敗しました:', failures);
  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}

chrome.notifications.onClicked.addListener(async (id) => {
  const links = (await chrome.storage.local.get('notificationLinks')).notificationLinks || {};
  const url = links[id] || 'https://travel.yahoo.co.jp/';
  await chrome.tabs.create({ url });
  delete links[id];
  await chrome.storage.local.set({ notificationLinks: links });
  chrome.notifications.clear(id);
});

// ------------------------------------------------------------ 重複の抑止

async function shouldNotify(signature, dedupeMinutes) {
  const stored = await chrome.storage.local.get('notified');
  const notified = stored.notified || {};
  const last = notified[signature];
  return !last || Date.now() - last >= dedupeMinutes * 60 * 1000;
}

async function markNotified(signature, dedupeMinutes) {
  const stored = await chrome.storage.local.get('notified');
  const notified = stored.notified || {};
  notified[signature] = Date.now();
  const cutoff = Date.now() - Math.max(dedupeMinutes, 1) * 60 * 1000 * 4;
  for (const [key, at] of Object.entries(notified)) {
    if (at < cutoff) delete notified[key];
  }
  await chrome.storage.local.set({ notified });
}

// ------------------------------------------------------------ 検出の受け口

async function handleCoupon(message, sender) {
  const settings = await Settings.getSettings();
  if (!settings.enabled) return;

  const hit = message.hit;
  const browser = Settings.browserName(navigator.userAgent);
  const signature = `${browser}|${hit.amount}`;

  await recordHistory({
    t: Date.now(),
    browser,
    target: message.targetName || message.pageTitle || '(手動閲覧)',
    url: message.pageUrl,
    detected: true,
    amount: hit.amount,
    score: hit.score,
    reasons: (hit.reasons || []).join('・'),
  });

  if (!(await shouldNotify(signature, settings.dedupeMinutes))) return;
  await markNotified(signature, settings.dedupeMinutes);

  const title = buildTitle(hit);
  const body = buildBody(hit, {
    claimed: message.claimed,
    pageUrl: message.pageUrl,
    userAgent: navigator.userAgent,
  });
  await notify(settings, title, body, message.pageUrl);
  await chrome.storage.local.set({
    lastHit: { t: Date.now(), amount: hit.amount, url: message.pageUrl, score: hit.score },
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getSettings') {
    Settings.getSettings().then((settings) => sendResponse({ settings }));
    return true;
  }
  if (message.type === 'coupon') {
    handleCoupon(message, sender).catch((e) => console.error(e));
    return false;
  }
  if (message.type === 'patrolNow') {
    patrol('manual').then(() => sendResponse({ ok: true })).catch((e) =>
      sendResponse({ ok: false, error: String(e) })
    );
    return true;
  }
  if (message.type === 'testNotify') {
    testNotify().then((r) => sendResponse(r)).catch((e) =>
      sendResponse({ ok: false, error: String(e) })
    );
    return true;
  }
  if (message.type === 'rescheduleAlarm') {
    scheduleNextPatrol().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

async function testNotify() {
  const settings = await Settings.getSettings();
  const hit = {
    amount: 5000, score: 17, code: 'TESTCODE', timeLimitMin: 180, source: 'popup',
    reasons: ['スペシャルクーポン', '180分限定', 'テスト送信'],
  };
  const ok = await notify(
    settings,
    '【テスト】' + buildTitle(hit),
    buildBody(hit, {
      claimed: false,
      pageUrl: 'https://travel.yahoo.co.jp/',
      userAgent: navigator.userAgent,
    }),
    'https://travel.yahoo.co.jp/'
  );
  return { ok };
}

// ---------------------------------------------------------------- 巡回

async function closeStalePatrolTab() {
  const stored = await chrome.storage.local.get(PATROL_TAB_KEY);
  const tabId = stored[PATROL_TAB_KEY];
  if (typeof tabId === 'number') {
    await chrome.tabs.remove(tabId).catch(() => {});
    await chrome.storage.local.remove(PATROL_TAB_KEY);
  }
}

async function visit(tabId, url, targetName, settings, browser) {
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  await sleep(jitter(settings.dwellSeconds * 1000, 0.4));

  const response = await sendToTab(tabId, { type: 'scan', targetName });
  const hits = (response && response.hits) || [];
  if (hits.length === 0) {
    await recordHistory({
      t: Date.now(),
      browser,
      target: targetName,
      url,
      detected: false,
      amount: null,
      score: 0,
      reasons: '',
    });
  }
  return hits.length;
}

let patrolling = false;

async function patrol(reason) {
  if (patrolling) return;
  const settings = await Settings.getSettings();
  if (!settings.enabled) return;
  if (reason !== 'manual') {
    if (!settings.patrolEnabled) return;
    if (Settings.inQuietHours(settings)) return;
    if (settings.maxPatrolsPerDay > 0 && (await dailyCount()) >= settings.maxPatrolsPerDay) return;
  }

  patrolling = true;
  const keepAlive = startKeepAlive();
  const browser = Settings.browserName(navigator.userAgent);
  let tab = null;
  try {
    await closeStalePatrolTab();
    if (reason !== 'manual') await bumpDailyCount();

    const targets = (settings.targets || []).filter((t) => Settings.isAllowedUrl(t.url));
    if (!targets.length) return;
    const target = targets[Math.floor(Math.random() * targets.length)];

    tab = await chrome.tabs.create({ url: 'about:blank', active: false, pinned: true });
    await chrome.storage.local.set({ [PATROL_TAB_KEY]: tab.id });

    await visit(tab.id, target.url, target.name || target.url, settings, browser);

    const wander = Math.max(0, Number(settings.wanderPages) || 0);
    for (let i = 0; i < wander; i++) {
      const response = await sendToTab(tab.id, { type: 'links' });
      const links = ((response && response.links) || []).filter(Settings.isAllowedUrl);
      const next = Settings.pickWeighted(links);
      if (!next) break;
      await visit(tab.id, next, `${target.name || 'ターゲット'} > 散策`, settings, browser);
    }
    await chrome.storage.local.set({ lastPatrolAt: Date.now() });
  } catch (e) {
    console.error('巡回に失敗しました', e);
  } finally {
    clearInterval(keepAlive);
    if (tab) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      await chrome.storage.local.remove(PATROL_TAB_KEY);
    }
    patrolling = false;
    if (reason !== 'manual') await scheduleNextPatrol();
  }
}

async function scheduleNextPatrol() {
  const settings = await Settings.getSettings();
  await chrome.alarms.clear(ALARM_PATROL);
  if (!settings.enabled || !settings.patrolEnabled) return;
  const minutes = Math.max(1, jitter(Number(settings.intervalMinutes) || 18, 0.4));
  await chrome.alarms.create(ALARM_PATROL, { delayInMinutes: minutes });
  await chrome.storage.local.set({ nextPatrolAt: Date.now() + minutes * 60 * 1000 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PATROL) patrol('alarm');
});

// ---------------------------------------------------------------- 起動時

async function bootstrap() {
  const settings = await Settings.getSettings();
  if (!settings.ntfyTopic) {
    // 初回だけ、推測されにくいトピック名を自動で作る。ユーザーは入力しなくていい。
    await Settings.saveSettings({ ntfyTopic: Settings.randomTopic() });
  }
  await closeStalePatrolTab();
  await scheduleNextPatrol();
}

chrome.runtime.onInstalled.addListener(() => bootstrap());
chrome.runtime.onStartup.addListener(() => bootstrap());
