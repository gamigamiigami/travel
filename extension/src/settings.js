/** 設定の既定値と読み書き。background / options / popup から使う。 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,

    // 通知
    notifyDesktop: true,
    notifyNtfy: true,
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',            // 初回起動時に自動生成する
    ntfyPriority: 5,
    notifyDiscord: false,
    discordWebhookUrl: '',

    // 巡回
    patrolEnabled: true,
    intervalMinutes: 18,      // ±40%のゆらぎを付けて使う
    wanderPages: 4,

    // 「具体的に宿を調べると出やすい」という噂に合わせて、巡回中に実際に
    // 検索を実行する。リンクを辿るだけより人間の動きに近い。
    searchEnabled: true,
    searchKeywords: [
      '箱根', '熱海', '京都', '草津温泉', '別府', '沖縄', '軽井沢',
      '有馬温泉', '城崎温泉', '日光', '伊豆', '白浜温泉', '登別温泉',
      '湯布院', '那須', '金沢', '高山', '鬼怒川温泉', '道後温泉', '蔵王',
    ],
    dwellSeconds: 9,
    quietStartHour: 1,
    quietEndHour: 7,
    maxPatrolsPerDay: 40,
    targets: [{ name: 'トップページ', url: 'https://travel.yahoo.co.jp/' }],

    // 検出
    minAmount: 1000,
    maxAmount: 100000,
    amountsWhitelist: [],
    minScorePage: 7,
    minScorePopup: 4,
    ignorePatterns: [],
    autoClaim: true,
    dedupeMinutes: 180,

    // 履歴
    historyEnabled: true,
    historyMax: 5000,
  };

  // 巡回してよいのは Yahoo!トラベル配下だけ。予約・決済・アカウント操作は踏まない。
  const ALLOWED_HOST_SUFFIX = 'travel.yahoo.co.jp';
  const BLOCKED_URL_PATTERNS = [
    '/reserve', '/reservation', '/booking', '/payment', '/order', '/cart',
    '/checkout', '/confirm', '/settlement', 'logout', 'login', 'signin',
    'account', 'mypage', 'edit\\.yahoo', 'login\\.yahoo', 'accounts\\.yahoo',
    '/review/(post|write)', '/inquiry', '/contact', '/cancel',
  ];
  // 「具体的に宿を調べている」動きを作るため、この形のリンクを優先する
  const PREFERRED_URL_PATTERNS = ['/dp/', '/hotel', '/domestic', '/area', '/search', '/onsen', '/theme', '/ranking'];

  function randomTopic() {
    const bytes = new Uint8Array(9);
    (globalThis.crypto || {}).getRandomValues?.(bytes);
    const suffix = Array.from(bytes, (b) => b.toString(36)).join('').slice(0, 14);
    return 'yt-coupon-' + (suffix || Math.random().toString(36).slice(2, 16));
  }

  async function getSettings() {
    const stored = await chrome.storage.local.get('settings');
    return Object.assign({}, DEFAULTS, stored.settings || {});
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = Object.assign({}, current, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  function isAllowedUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== ALLOWED_HOST_SUFFIX && !host.endsWith('.' + ALLOWED_HOST_SUFFIX)) return false;
    return !BLOCKED_URL_PATTERNS.some((pattern) => new RegExp(pattern, 'i').test(url));
  }

  function linkWeight(url) {
    return PREFERRED_URL_PATTERNS.some((pattern) => new RegExp(pattern, 'i').test(url)) ? 4 : 1;
  }

  function pickWeighted(urls) {
    if (!urls.length) return null;
    const weights = urls.map(linkWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < urls.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return urls[i];
    }
    return urls[urls.length - 1];
  }

  function inQuietHours(settings, date) {
    const start = Number(settings.quietStartHour);
    const end = Number(settings.quietEndHour);
    if (start === end) return false;
    const hour = (date || new Date()).getHours();
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  function browserName(userAgent) {
    const ua = userAgent || (globalThis.navigator ? navigator.userAgent : '');
    if (/Edg\//.test(ua)) return 'edge';
    if (/OPR\//.test(ua)) return 'opera';
    if (/Chrome\//.test(ua)) return 'chrome';
    return 'other';
  }

  const Settings = {
    DEFAULTS,
    ALLOWED_HOST_SUFFIX,
    BLOCKED_URL_PATTERNS,
    PREFERRED_URL_PATTERNS,
    randomTopic,
    getSettings,
    saveSettings,
    isAllowedUrl,
    linkWeight,
    pickWeighted,
    inQuietHours,
    browserName,
  };

  root.Settings = Settings;
  if (typeof module !== 'undefined' && module.exports) module.exports = Settings;
})(typeof globalThis !== 'undefined' ? globalThis : this);
