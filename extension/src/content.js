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

  // クーポンのポップアップが travel.yahoo.co.jp 以外のドメインの iframe で
  // 描画されている場合に備え、Yahoo系ドメイン全体に読み込まれる設定にしてある。
  // ただし実際に動くのは「Yahoo!トラベルの中にいるフレーム」だけに限る。
  if (!isInsideYahooTravel()) return;

  function isInsideYahooTravel() {
    const isTravel = (host) => /(^|\.)travel\.yahoo\.co\.jp$/i.test(host);
    if (isTravel(location.hostname)) return true;
    try {
      const ancestors = location.ancestorOrigins;
      if (!ancestors) return false;
      for (let i = 0; i < ancestors.length; i++) {
        if (isTravel(new URL(ancestors[i]).hostname)) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

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

  // 検索窓らしき入力欄。サイトの作りが変わっても、どれか当たれば良い。
  const SEARCH_INPUT_SELECTORS = [
    'input[type="search"]',
    'input[name*="keyword" i]',
    'input[name*="query" i]',
    'input[name*="word" i]',
    'input[placeholder*="エリア"]',
    'input[placeholder*="地名"]',
    'input[placeholder*="宿"]',
    'input[placeholder*="ホテル"]',
    'input[placeholder*="キーワード"]',
    'input[placeholder*="目的地"]',
    'input[aria-label*="検索"]',
    'form input[type="text"]',
  ];
  const SEARCH_BUTTON_TEXTS = ['検索', 'さがす', '探す', 'この条件で'];

  // 検索結果カードに出ている料金。「12,000円」「¥12,000」など。
  const PRICE_RE = /(?:￥|¥)?\s*([0-9０-９][0-9０-９,，]{2,})\s*円?/g;
  const PRICE_MIN = 2000;
  const PRICE_MAX = 1000000;

  // ★ 検出の本丸。
  // Yahoo!トラベルのクーポンは、畳まれた状態では「残155分」という
  // カウントダウンのバッジしか出ない。「クーポン」の語も金額も無い。
  // 金額は展開して初めて出てくるので、まずこのバッジ自体を
  // 「クーポンが出ている証拠」として扱う。
  const COUNTDOWN_RE = /残\s*([0-9]{1,4})\s*分/;
  const BADGE_SELECTORS = [
    "[class*='popup-badge']",
    "[class*='oupon-badge']",
    "[class*='ouponBadge']",
    "[class*='badge-counter']",
    "[class*='badge']",
  ];
  const MAX_BADGE_TEXT = 60;

  const MAX_POPUP_TEXT = 6000;
  const MAX_BODY_TEXT = 200000;
  const SCAN_COOLDOWN_MS = 3000;
  const DEBOUNCE_MS = 900;

  let settings = null;
  let lastScanAt = 0;
  let expandTried = false;
  const reportedNearMiss = new Set();
  let debounceTimer = null;
  const claimed = new Set();

  const isTopFrame = window.top === window;

  /**
   * Shadow DOM の中を集める。
   *
   * ポップアップが shadow root の中に作られていると、document への
   * querySelectorAll も body.innerText も中身に届かない。ここを見ないと
   * 「画面には出ているのに検出できない」が起きる。
   */
  function shadowRoots(limit) {
    const roots = [];
    const walk = (root, depth) => {
      if (depth > 5 || roots.length >= (limit || 40)) return;
      let elements;
      try {
        elements = root.querySelectorAll('*');
      } catch (e) {
        return;
      }
      for (const element of elements) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
          walk(element.shadowRoot, depth + 1);
          if (roots.length >= (limit || 40)) return;
        }
      }
    };
    walk(document, 0);
    return roots;
  }

  /** 要素そのものの文字に加えて、画像のaltや aria-label も拾う。 */
  function textWithLabels(element) {
    let text = element.innerText || '';
    try {
      const labelled = element.querySelectorAll('img[alt], [aria-label], [title]');
      const labels = [];
      for (const node of Array.from(labelled).slice(0, 40)) {
        const label =
          node.getAttribute('alt') ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title');
        if (label && label.length <= 200) labels.push(label);
      }
      if (labels.length) text += '\n' + labels.join('\n');
    } catch (e) {
      /* 属性が取れなくても本文だけで判定する */
    }
    return text;
  }

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
  function scanPopups(minScore) {
    const hits = [];
    const seen = new Set();
    const roots = [document].concat(shadowRoots());
    for (const root of roots) {
      for (const selector of POPUP_SELECTORS) {
        let elements;
        try {
          elements = root.querySelectorAll(selector);
        } catch (e) {
          continue;
        }
        for (const element of Array.from(elements).slice(0, 8)) {
          if (seen.has(element) || !isVisible(element)) continue;
          seen.add(element);
          const text = textWithLabels(element);
          if (!text || text.length > MAX_POPUP_TEXT) continue;
          const found = D.scanText(
            text,
            Object.assign(baseOptions('popup'), { strict: false, minScore })
          );
          for (const hit of found) hits.push({ hit, element });
        }
      }
    }
    return hits;
  }

  /** ページ全体を、強いキーワード必須の厳しい条件で見る。 */
  function pageText() {
    let text = (document.body && document.body.innerText) || '';
    for (const root of shadowRoots(20)) {
      try {
        text += '\n' + (root.textContent || '');
      } catch (e) {
        /* 読めない shadow root は飛ばす */
      }
    }
    return text.slice(0, MAX_BODY_TEXT);
  }

  function scanWholePage(minScore) {
    const text = pageText();
    if (!text) return [];
    const found = D.scanText(
      text,
      Object.assign(baseOptions('page'), { strict: true, minScore })
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

  /**
   * カウントダウンのバッジを探す。見つかればクーポンが出ている。
   * バッジは文字数が少ないので、長いテキストの要素は除外する。
   */
  function findCouponBadge() {
    const roots = [document].concat(shadowRoots());
    const selectors = BADGE_SELECTORS.concat(POPUP_SELECTORS);
    for (const root of roots) {
      for (const selector of selectors) {
        let elements;
        try {
          elements = root.querySelectorAll(selector);
        } catch (e) {
          continue;
        }
        for (const element of Array.from(elements).slice(0, 12)) {
          if (!isVisible(element)) continue;
          const text = (element.innerText || '').trim();
          if (!text || text.length > MAX_BADGE_TEXT) continue;
          const match = COUNTDOWN_RE.exec(text);
          if (!match) continue;
          const minutes = Number(match[1]);
          if (!(minutes >= 1 && minutes <= 1440)) continue;
          return { element, minutes, text };
        }
      }
    }
    return null;
  }

  /**
   * バッジを押して中身（金額）を出す。
   * 「予約」「決済」などの語を含む要素は絶対に押さない。
   */
  function expandBadge(element) {
    const label = (element.innerText || '').slice(0, 100);
    if (CLICK_FORBIDDEN.test(label)) return false;
    try {
      element.click();
      return true;
    } catch (e) {
      return false;
    }
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

    // いったん「しきい値なし」で全部拾い、あとで足切りする。
    // 足切りされたものも記録しておけば「惜しかった」が分かり、調整できる。
    let candidates;
    try {
      candidates = best(scanPopups(0).concat(scanWholePage(0)));
    } catch (e) {
      return [];
    }

    const threshold = (hit) =>
      hit.source === 'popup' ? settings.minScorePopup : settings.minScorePage;
    const results = candidates.filter(({ hit }) => hit.score >= threshold(hit));
    const nearMisses = candidates.filter(({ hit }) => hit.score < threshold(hit));

    for (const { hit } of nearMisses) {
      const key = `${hit.amount}|${hit.score}`;
      if (reportedNearMiss.has(key)) continue;
      reportedNearMiss.add(key);
      chrome.runtime.sendMessage({
        type: 'nearMiss',
        hit,
        threshold: threshold(hit),
        pageUrl: location.href,
      }).catch(() => {});
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

    // 金額が取れなくても、カウントダウンのバッジが出ていればクーポンはある。
    // 見逃すくらいなら「金額不明」で先に知らせる。60分で消えるのだから。
    if (!results.length) {
      const badge = findCouponBadge();
      if (badge) {
        chrome.runtime.sendMessage({
          type: 'coupon',
          hit: {
            amount: null,
            score: 99,
            reasons: ['残り時間バッジ'],
            code: null,
            timeLimitMin: badge.minutes,
            snippet: badge.text,
            source: 'badge',
            url: location.href,
          },
          claimed: false,
          pageTitle: document.title,
          pageUrl: location.href,
          targetName: targetName || null,
          reason,
        }).catch(() => {});

        // バッジを開けば金額が出る。開いたあとにもう一度見る。
        if (settings.expandBadge && !expandTried) {
          expandTried = true;
          if (expandBadge(badge.element)) {
            setTimeout(() => scan('afterExpand', targetName), 1500);
          }
        }
      }
    }
    return results;
  }

  /**
   * 検索窓に地名を入れて実行する。
   *
   * React などで作られた入力欄は value を直接書き換えても気づかれないので、
   * ネイティブの setter を呼んでから input/change を発火させる。
   */
  function fillAndSearch(keyword) {
    const input = findSearchInput();
    if (!input) return { ok: false, reason: '検索窓が見つかりません' };

    try {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      input.focus();
      setter.call(input, keyword);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      return { ok: false, reason: '入力に失敗しました' };
    }

    return { ok: submitSearch(input), reason: 'submitted' };
  }

  function findSearchInput() {
    for (const selector of SEARCH_INPUT_SELECTORS) {
      let elements;
      try {
        elements = document.querySelectorAll(selector);
      } catch (e) {
        continue;
      }
      for (const element of elements) {
        if (element.disabled || element.readOnly) continue;
        if (!isVisible(element)) continue;
        return element;
      }
    }
    return null;
  }

  function submitSearch(input) {
    // 1) 近くの検索ボタンを押す（予約・決済系の語を含むものは押さない）
    const scope = input.closest('form') || document.body;
    const buttons = scope.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (const button of Array.from(buttons).slice(0, 60)) {
      const label = (button.innerText || button.value || button.getAttribute('aria-label') || '').trim();
      if (!label || !SEARCH_BUTTON_TEXTS.some((text) => label.includes(text))) continue;
      if (CLICK_FORBIDDEN.test(label)) continue;
      if (!isVisible(button)) continue;
      button.click();
      return true;
    }
    // 2) フォームがあれば submit
    if (input.form && typeof input.form.requestSubmit === 'function') {
      input.form.requestSubmit();
      return true;
    }
    // 3) 最後の手段として Enter を送る
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })
      );
    }
    return true;
  }

  /**
   * リンクが載っているカードの表示価格を読む。
   *
   * 価格の絞り込みURLの仕様が分からないので、検索結果に「見えている」金額から
   * 判断する。1枚のカードに「1泊12,000円〜」と「合計24,000円」が併記される
   * ことがあるため、最小値を採る。最小値が閾値を超えていれば、どう数えても
   * 高価格帯だと言える。
   */
  function cardPrice(anchor) {
    let node = anchor;
    for (let depth = 0; depth < 5 && node; depth++) {
      const text = node.innerText || '';
      if (text.length >= 20) {
        const prices = [];
        for (const match of text.matchAll(PRICE_RE)) {
          const value = D.toInt(match[1]);
          if (value !== null && value >= PRICE_MIN && value <= PRICE_MAX) prices.push(value);
        }
        if (prices.length) return Math.min(...prices);
      }
      node = node.parentElement;
    }
    return null;
  }

  /** 巡回用: 辿れるリンクを、分かる範囲の表示価格つきで返す。 */
  function collectLinks() {
    const seen = new Set();
    const items = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href');
      if (!href || /^(#|javascript:|mailto:|tel:)/.test(href)) continue;
      let absolute;
      try {
        absolute = new URL(href, location.href).href.split('#')[0];
      } catch (e) {
        continue;
      }
      if (absolute === location.href || seen.has(absolute)) continue;
      seen.add(absolute);
      // 価格を読むのは宿の詳細らしきリンクだけ。全リンクでやると重い。
      const price = /\/dp\/|hotel|yad/i.test(absolute) ? cardPrice(anchor) : null;
      items.push({ url: absolute, price });
      if (items.length >= 400) break;
    }
    return items;
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
    if (message.type === 'search') {
      sendResponse(fillAndSearch(message.keyword));
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
