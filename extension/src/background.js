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

/** ログに出すための短いURL表記。 */
function shortUrl(url) {
  try {
    const parsed = new URL(url);
    const path = (parsed.pathname + parsed.search).slice(0, 60);
    return path === '/' ? 'トップ' : path;
  } catch (e) {
    return String(url || '').slice(0, 60);
  }
}
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

// ------------------------------------------------------------ 巡回ログ

const ACTIVITY_MAX = 200;

/** 巡回中に何をしたかを残す。裏で動くので、見えないと不安になるため。 */
async function logActivity(message, level) {
  try {
    const stored = await chrome.storage.local.get('activity');
    const activity = stored.activity || [];
    activity.push({ t: Date.now(), level: level || 'info', message: String(message) });
    if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
    await chrome.storage.local.set({ activity });
  } catch (e) {
    /* ログのために巡回を止めない */
  }
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
  if (hit.amount) return `🎫 ${hit.amount.toLocaleString()}円OFFクーポン出現！`;
  // 畳まれたバッジの段階では金額が画面に出ていない。それでも急いで知らせる。
  const remaining = hit.timeLimitMin ? `（残${hit.timeLimitMin}分）` : '';
  return `🎫 クーポンが出ています！${remaining}`;
}

function buildBody(hit, context) {
  const lines = [
    hit.amount
      ? `金額: ${hit.amount.toLocaleString()}円OFF`
      : '金額: 画面にまだ出ていません（バッジを開くと分かります）',
  ];
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
  // 金額が分かる前と後で別々に通知したい。金額不明のときは「いつ切れるか」で
  // 区別する。同じクーポンなら失効時刻は変わらないので、繰り返し通知されない。
  const signature = hit.amount
    ? `${browser}|${hit.amount}`
    : `${browser}|badge|${Math.round(
        (Date.now() + (hit.timeLimitMin || 0) * 60000) / 600000
      )}`;

  await recordHistory({
    t: Date.now(),
    browser,
    target: message.targetName || message.pageTitle || '(手動閲覧)',
    url: message.pageUrl,
    detected: true,
    amount: hit.amount || null,
    score: hit.score,
    reasons: (hit.reasons || []).join('・'),
  });

  if (!(await shouldNotify(signature, settings.dedupeMinutes))) {
    // 検出はしている。通知しないのは「同じものを既に知らせたから」。
    // これを黙って捨てると、動いていないように見えてしまう。
    const stored = await chrome.storage.local.get('notified');
    const last = (stored.notified || {})[signature] || Date.now();
    const remaining = Math.max(
      0,
      Math.round((settings.dedupeMinutes * 60000 - (Date.now() - last)) / 60000)
    );
    await logActivity(
      `検出しましたが通知済みのため見送り：${
        hit.amount ? hit.amount.toLocaleString() + '円' : '金額不明'
      }（あと約${remaining}分で再通知できます）`
    );
    return;
  }
  await markNotified(signature, settings.dedupeMinutes);

  const title = buildTitle(hit);
  const body = buildBody(hit, {
    claimed: message.claimed,
    pageUrl: message.pageUrl,
    userAgent: navigator.userAgent,
  });
  await notify(settings, title, body, message.pageUrl);
  await chrome.storage.local.set({
    lastHit: {
      t: Date.now(),
      amount: hit.amount || null,
      timeLimitMin: hit.timeLimitMin || null,
      url: message.pageUrl,
      score: hit.score,
    },
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getSettings') {
    Settings.getSettings().then((settings) => sendResponse({ settings }));
    return true;
  }
  if (message.type === 'scriptError') {
    // ページ側で起きた不具合。DevTools を開かなくても巡回ログで読める。
    logActivity(`エラー（${message.where}）: ${message.detail}`, 'warn');
    return false;
  }
  if (message.type === 'skipped') {
    const hit = message.hit || {};
    logActivity(
      `見送り：${(hit.amount || 0).toLocaleString()}円 を見つけましたが、${message.reason}`
    );
    return false;
  }
  if (message.type === 'nearMiss') {
    // 検出はしなかったが、それらしいものは見えていた、という記録。
    // しきい値を下げるべきか判断する材料になる。
    const hit = message.hit || {};
    logActivity(
      `惜しい：${(hit.amount || 0).toLocaleString()}円 を見つけましたが score=${hit.score} で` +
        `しきい値${message.threshold}に届かず（根拠: ${(hit.reasons || []).join('・') || 'なし'}）`,
      'warn'
    );
    return false;
  }
  if (message.type === 'coupon') {
    handleCoupon(message, sender).catch((e) => console.error(e));
    return false;
  }
  if (message.type === 'patrolNow') {
    patrol('manual', { visible: !!message.visible })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message.type === 'testNotify') {
    testNotify().then((r) => sendResponse(r)).catch((e) =>
      sendResponse({ ok: false, error: String(e) })
    );
    return true;
  }
  if (message.type === 'resetDedupe') {
    chrome.storage.local
      .set({ notified: {} })
      .then(() => logActivity('重複抑止をリセットしました'))
      .then(() => sendResponse({ ok: true }));
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

/** ページを少し眺めてから調べ、結果を履歴に残す。 */
async function dwellAndScan(tabId, url, targetName, settings, browser) {
  await sleep(jitter(settings.dwellSeconds * 1000, 0.4));

  const response = await sendToTab(tabId, { type: 'scan', targetName });
  const hits = (response && response.hits) || [];
  if (!response) {
    await logActivity(`${targetName}：ページを読み取れませんでした`, 'warn');
  } else if (hits.length) {
    await logActivity(
      `${targetName}：` +
        hits
          .map((h) => (h.amount ? h.amount.toLocaleString() + '円' : '金額不明のクーポン'))
          .join('・') +
        ' を検出',
      'hit'
    );
  } else {
    await logActivity(`${targetName}：クーポンなし`);
  }
  if (hits.length === 0) {
    await recordHistory({
      t: Date.now(),
      browser,
      target: targetName,
      url: (response && response.url) || url,
      detected: false,
      amount: null,
      score: 0,
      reasons: '',
    });
  }
  return hits.length;
}

async function visit(tabId, url, targetName, settings, browser) {
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  return dwellAndScan(tabId, url, targetName, settings, browser);
}

/**
 * 検索窓に地名を入れて実際に検索する。
 *
 * 「具体的に宿を調べると出やすい」という噂に合わせた動き。リンクを辿るだけ
 * より人間の行動に近く、検索結果からは宿の詳細ページにも入りやすい。
 */
async function search(tabId, keyword, targetName, settings, browser) {
  await logActivity(`「${keyword}」で検索します`);
  const before = await chrome.tabs.get(tabId).catch(() => null);
  const response = await sendToTab(tabId, { type: 'search', keyword });
  if (!response || !response.ok) {
    await logActivity(
      `検索できませんでした（${(response && response.reason) || '応答なし'}）`,
      'warn'
    );
    return 0;
  }
  // 検索がページ遷移になるか画面内で完結するかは分からないので、
  // 遷移を待ちつつ、待てなくても先に進む。
  await Promise.race([waitForLoad(tabId, 15000), sleep(6000)]);
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  // 「検索を実行した」と「実際に検索結果に移った」は別物なので、URLの変化で確かめる。
  const beforeUrl = (before && before.url) || '';
  const afterUrl = (tab && tab.url) || '';
  if (afterUrl && afterUrl !== beforeUrl) {
    await logActivity(`検索できました → ${shortUrl(afterUrl)}`);
  } else {
    await logActivity('検索を実行しましたが、ページが変わりませんでした', 'warn');
  }
  return dwellAndScan(tabId, (tab && tab.url) || '', `${targetName} > 検索:${keyword}`, settings, browser);
}

let patrolling = false;

async function patrol(reason, options) {
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

    const visible = !!(options && options.visible);
    await logActivity(
      `巡回開始：${target.name || target.url}${visible ? '（表示モード）' : ''}`
    );
    tab = await chrome.tabs.create({
      url: 'about:blank',
      active: visible,
      pinned: !visible,
    });
    if (visible) {
      // 表示モードのときはウィンドウ自体も前面に出す。
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.storage.local.set({ [PATROL_TAB_KEY]: tab.id });

    const targetName = target.name || target.url;
    await visit(tab.id, target.url, targetName, settings, browser);

    // トップページを見たら、次は実際に地名で検索してみる。
    const keywords = settings.searchKeywords || [];
    if (settings.searchEnabled && keywords.length) {
      const keyword = keywords[Math.floor(Math.random() * keywords.length)];
      await search(tab.id, keyword, targetName, settings, browser);
    }

    const wander = Math.max(0, Number(settings.wanderPages) || 0);
    for (let i = 0; i < wander; i++) {
      const response = await sendToTab(tab.id, { type: 'links' });
      const items = (response && response.links) || [];
      const threshold = Number(settings.minHotelPrice) || 0;
      const priced = items.filter((item) => typeof item.price === 'number');
      const expensive = priced.filter((item) => item.price >= threshold);
      await logActivity(
        `リンク${items.length}件（価格が読めたもの${priced.length}件／` +
          `${threshold.toLocaleString()}円以上 ${expensive.length}件）`
      );
      const next = Settings.pickLink(items, settings);
      if (!next) {
        await logActivity('たどれるリンクがありませんでした', 'warn');
        break;
      }
      // 価格が読めたときは履歴にも残す。あとで「高い宿のほうが出るのか」を検証できる。
      const label = next.price
        ? `${targetName} > 宿(${next.price.toLocaleString()}円)`
        : `${targetName} > 散策`;
      await logActivity(
        next.price ? `宿を開きます（${next.price.toLocaleString()}円）` : `次のページへ：${shortUrl(next.url)}`
      );
      await visit(tab.id, next.url, label, settings, browser);
    }
    await chrome.storage.local.set({ lastPatrolAt: Date.now() });
  } catch (e) {
    console.error('巡回に失敗しました', e);
    await logActivity('巡回中にエラー: ' + ((e && e.message) || e), 'warn');
  } finally {
    await logActivity('巡回終了');
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
  // どの版が動いているかをログに残す。ファイルの入れ替え漏れの切り分け用。
  try {
    await logActivity(`起動しました（v${chrome.runtime.getManifest().version}）`);
  } catch (e) {
    /* ログに失敗しても起動は続ける */
  }
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
