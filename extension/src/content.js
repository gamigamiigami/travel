/**
 * ページの中に住んで、クーポンのポップアップが出た瞬間に気づく。
 *
 * 巡回中だけでなく、あなたが普段Yahoo!トラベルを見ている最中も監視している。
 * all_frames: true なので iframe の中にもこのスクリプトが入る。つまり
 * ポップアップが iframe で描画されていても、そのフレーム自身が検出する。
 */
(function () {
  'use strict';

  // popup からの再注入などで2回読み込まれても、監視を二重に走らせない。
  if (globalThis.__ytCouponWatcherLoaded) return;
  globalThis.__ytCouponWatcherLoaded = true;

  const D = globalThis.CouponDetector;
  if (!D) return;

  // クーポンのポップアップが入っていそうな入れ物。どれか当たれば良い。
  const POPUP_SELECTORS = [
    "[role='dialog']", "[aria-modal='true']", 'dialog',
    "[class*='oupon']", "[id*='oupon']", "[data-testid*='oupon']",
    "[class*='odal']", "[class*='opup']", "[class*='alloon']", "[class*='oast']",
  ];

  // 獲得ボタンでも、これらの語を含むものは絶対に押さない。
  const CLICK_FORBIDDEN = /予約|決済|購入|支払|申込|申し込|確定|キャンセル|退会|ログアウト|削除/;
  const CLAIM_TEXTS = [
    'クーポンを獲得', '獲得する', 'クーポンをもらう', '受け取る',
    'クーポンをゲット', 'ゲットする', '今すぐ獲得',
  ];

  const MAX_POPUP_TEXT = 6000;
  const MAX_BODY_TEXT = 200000;
  const SCAN_COOLDOWN_MS = 3000;
  const DEBOUNCE_MS = 900;

  let settings = null;
  let lastScanAt = 0;
  let debounceTimer = null;
  const claimed = new Set();

  const isTopFrame = window.top === window;

  function isVisible(element) {
    if (!element) return false;
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function baseOptions(source) {
    return {
      minAmount: settings.minAmount,
      maxAmount: settings.maxAmount,
      amountsWhitelist: settings.amountsWhitelist,
      ignorePatterns: settings.ignorePatterns,
      source,
      url: location.href,
      frameUrl: isTopFrame ? null : location.href,
    };
  }

  /** ポップアップらしき要素の中を、ゆるい条件で見る。 */
  function scanPopups() {
    const hits = [];
    const seen = new Set();
    for (const selector of POPUP_SELECTORS) {
      let elements;
      try {
        elements = document.querySelectorAll(selector);
      } catch (e) {
        continue;
      }
      for (const element of Array.from(elements).slice(0, 8)) {
        if (seen.has(element) || !isVisible(element)) continue;
        seen.add(element);
        const text = element.innerText;
        if (!text || text.length > MAX_POPUP_TEXT) continue;
        const found = D.scanText(
          text,
          Object.assign(baseOptions('popup'), {
            strict: false,
            minScore: settings.minScorePopup,
          })
        );
        for (const hit of found) hits.push({ hit, element });
      }
    }
    return hits;
  }

  /** ページ全体を、強いキーワード必須の厳しい条件で見る。 */
  function scanWholePage() {
    const text = (document.body && document.body.innerText) || '';
    if (!text) return [];
    const found = D.scanText(
      text.slice(0, MAX_BODY_TEXT),
      Object.assign(baseOptions('page'), {
        strict: true,
        minScore: settings.minScorePage,
      })
    );
    return found.map((hit) => ({ hit, element: null }));
  }

  /** 「クーポンを獲得」ボタンがあれば押す。予約・決済系は絶対に押さない。 */
  function tryClaim(container) {
    if (!settings.autoClaim) return false;
    const root = container || document.body;
    if (!root) return false;
    const candidates = root.querySelectorAll('button, a, [role="button"], input[type="button"]');
    for (const element of Array.from(candidates).slice(0, 120)) {
      const label = (element.innerText || element.value || '').trim().slice(0, 120);
      if (!label || !CLAIM_TEXTS.some((text) => label.includes(text))) continue;
      if (CLICK_FORBIDDEN.test(label)) continue;
      if (!isVisible(element)) continue;
      const key = label + '@' + location.href;
      if (claimed.has(key)) continue;
      claimed.add(key);
      try {
        element.click();
        return true;
      } catch (e) {
        /* 押せなくても検出と通知は続ける */
      }
    }
    return false;
  }

  function best(results) {
    const byAmount = new Map();
    for (const { hit, element } of results) {
      const previous = byAmount.get(hit.amount);
      if (!previous || hit.score > previous.hit.score) byAmount.set(hit.amount, { hit, element });
    }
    return Array.from(byAmount.values()).sort((a, b) => b.hit.amount - a.hit.amount);
  }

  function scan(reason, targetName) {
    if (!settings || !settings.enabled) return [];
    const now = Date.now();
    if (reason !== 'manual' && now - lastScanAt < SCAN_COOLDOWN_MS) return [];
    lastScanAt = now;

    let results;
    try {
      results = best(scanPopups().concat(scanWholePage()));
    } catch (e) {
      return [];
    }

    for (const { hit, element } of results) {
      const claimedNow = tryClaim(element);
      chrome.runtime.sendMessage({
        type: 'coupon',
        hit,
        claimed: claimedNow,
        pageTitle: document.title,
        pageUrl: location.href,
        targetName: targetName || null,
        reason,
      }).catch(() => {});
    }
    return results;
  }

  /** 巡回用: このページから辿れるリンクを返す。絞り込みは background 側で行う。 */
  function collectLinks() {
    const urls = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href');
      if (!href || /^(#|javascript:|mailto:|tel:)/.test(href)) continue;
      let absolute;
      try {
        absolute = new URL(href, location.href).href.split('#')[0];
      } catch (e) {
        continue;
      }
      if (absolute !== location.href) urls.add(absolute);
    }
    return Array.from(urls).slice(0, 400);
  }

  function scheduleScan(reason) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scan(reason), DEBOUNCE_MS);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'scan') {
      // 注入直後は設定をまだ持っていないことがある。その場合は取ってから調べる。
      const run = settings
        ? Promise.resolve()
        : chrome.runtime.sendMessage({ type: 'getSettings' })
            .then((response) => {
              settings = response && response.settings;
            })
            .catch(() => {});
      run.then(() => {
        const results = scan('manual', message.targetName);
        sendResponse({
          ok: true,
          hits: results.map((r) => r.hit),
          title: document.title,
          url: location.href,
        });
      });
      return true;
    }
    if (message.type === 'links') {
      sendResponse({ ok: true, links: isTopFrame ? collectLinks() : [] });
      return true;
    }
    if (message.type === 'settingsChanged') {
      settings = message.settings;
      return false;
    }
    return false;
  });

  async function start() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getSettings' });
      settings = response && response.settings;
    } catch (e) {
      return;
    }
    if (!settings) return;

    // ポップアップは読み込み直後に出たり、少し遅れて出たりする。
    for (const delay of [800, 2500, 6000, 12000]) setTimeout(() => scan('load'), delay);

    const observer = new MutationObserver(() => scheduleScan('mutation'));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  start();
})();
