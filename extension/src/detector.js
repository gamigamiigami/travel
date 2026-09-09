/**
 * クーポン検出ロジック。
 *
 * Python版と同じ考え方:
 *   1. 金額がクーポン系キーワードの近くにあること（宿の価格との取り違え防止）
 *   2. 周辺テキストのスコアがしきい値以上であること
 *
 * content script でもテストでも使えるよう、グローバルにもCommonJSにも公開する。
 */
(function (root) {
  'use strict';

  const STRONG_KEYWORDS = [
    'スペシャルクーポン', '限定クーポン', 'クーポンを獲得', 'クーポン獲得',
    'クーポンをゲット', 'クーポンをもらう', 'クーポンを受け取', 'クーポンプレゼント',
    'クーポンが当たり', 'クーポンをプレゼント', 'あなただけのクーポン',
    'タイムセールクーポン',
  ];
  const WEAK_KEYWORDS = STRONG_KEYWORDS.concat(['クーポン', 'coupon', 'COUPON']);

  // 正規表現は「使うたびに作る」。g フラグ付きのオブジェクトを使い回すと
  // lastIndex が呼び出し間で持ち越され、入れ子で使ったときに走査位置が
  // 巻き戻って無限ループになる。パターンは文字列で持ち、都度生成する。
  const P_AMOUNT_OFF =
    '([0-9０-９][0-9０-９,，、]{0,9})\\s*円\\s*(?:OFF|off|Off|ＯＦＦ|オフ|割引|引き|引)';
  const P_AMOUNT_COUPON =
    '([0-9０-９][0-9０-９,，、]{0,9})\\s*円\\s*(?:分\\s*)?(?:の\\s*)?クーポン';
  // 有効時間。60分 / 90分 / 180分 の3種があるので分表記全般を拾う
  const P_TIME_LIMIT = '(?:残り|あと|以内|限定)?\\s*([0-9]{1,4})\\s*分\\s*(?:限定|以内|間)?';
  const P_CODE = '\\b([A-Z0-9]{6,16})\\b';

  const re = (pattern) => new RegExp(pattern, 'g');

  const SCORE_RULES = [
    [/スペシャルクーポン/, 5, 'スペシャルクーポン'],
    [/限定クーポン|あなただけのクーポン|クーポンプレゼント|クーポンをプレゼント/, 4, '限定クーポン'],
    [/クーポンを?(?:獲得|ゲット|もらう|受け取)/, 3, '獲得ボタン'],
    [/時間限定|期間限定|今だけ/, 3, '時間限定'],
    [/クーポン/, 1, 'クーポン表記'],
  ];
  const SCORE_TIME_LIMIT = 4;
  const SCORE_AMOUNT_OFF = 2;
  const SCORE_COUPON_CODE = 2;

  const CODE_STOPWORDS = new Set(['COUPON', 'SPECIAL', 'YAHOO', 'TRAVEL', 'OFF']);

  function toHalfWidth(text) {
    return String(text).replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
  }

  function toInt(raw) {
    const normalized = toHalfWidth(raw).replace(/[,，、]/g, '');
    if (!/^\d+$/.test(normalized)) return null;
    return parseInt(normalized, 10);
  }

  function findCode(snippet) {
    for (const match of snippet.matchAll(re(P_CODE))) {
      const candidate = match[1];
      if (/^\d+$/.test(candidate)) continue;      // 純粋な数字は金額の可能性
      if (CODE_STOPWORDS.has(candidate)) continue;
      if (!/\d/.test(candidate)) continue;         // 数字を含まない英単語は除外
      return candidate;
    }
    return null;
  }

  function findTimeLimit(snippet) {
    let best = null;
    for (const match of snippet.matchAll(re(P_TIME_LIMIT))) {
      const value = toInt(match[1]);
      if (value === null || value < 1 || value > 1440) continue;
      if (best === null || value > best) best = value;
    }
    return best;
  }

  function scoreText(text) {
    let score = 0;
    const reasons = [];
    for (const [pattern, points, label] of SCORE_RULES) {
      if (pattern.test(text)) {
        score += points;
        reasons.push(label);
      }
    }
    const limit = findTimeLimit(text);
    if (limit !== null) {
      score += SCORE_TIME_LIMIT;
      reasons.push(limit + '分限定');
    }
    if (re(P_AMOUNT_OFF).test(text)) {
      score += SCORE_AMOUNT_OFF;
      reasons.push('円OFF表記');
    }
    if (findCode(text)) {
      score += SCORE_COUPON_CODE;
      reasons.push('クーポンコード');
    }
    return { score, reasons };
  }

  function keywordSpans(text, keywords) {
    const lowered = text.toLowerCase();
    const spans = [];
    for (const keyword of keywords) {
      const needle = keyword.toLowerCase();
      let from = 0;
      for (;;) {
        const index = lowered.indexOf(needle, from);
        if (index < 0) break;
        spans.push([index, index + needle.length]);
        from = index + 1;
      }
    }
    return spans;
  }

  function isNearby(spans, position, window) {
    return spans.some(([start, end]) => position >= start - window && position <= end + window);
  }

  /**
   * テキストからクーポンを探す。
   * options: { strict, minScore, minAmount, maxAmount, amountsWhitelist,
   *            ignorePatterns, window, source, url, frameUrl }
   */
  function scanText(text, options) {
    const opts = Object.assign(
      {
        strict: true,
        minScore: 0,
        minAmount: 1000,
        maxAmount: 100000,
        amountsWhitelist: [],
        ignorePatterns: [],
        window: 160,
        source: 'page',
        url: null,
        frameUrl: null,
      },
      options || {}
    );
    if (!text) return [];

    for (const pattern of opts.ignorePatterns) {
      try {
        if (new RegExp(pattern).test(text)) return [];
      } catch (e) {
        /* 壊れた正規表現は無視する */
      }
    }

    const spans = keywordSpans(text, opts.strict ? STRONG_KEYWORDS : WEAK_KEYWORDS);
    if (spans.length === 0) return [];

    const whitelist = new Set(opts.amountsWhitelist || []);
    const hits = new Map();

    for (const [pattern, needsKeyword] of [[P_AMOUNT_OFF, true], [P_AMOUNT_COUPON, false]]) {
      for (const match of text.matchAll(re(pattern))) {
        const amount = toInt(match[1]);
        if (amount === null) continue;
        if (whitelist.size > 0) {
          if (!whitelist.has(amount)) continue;
        } else if (amount < opts.minAmount || amount > opts.maxAmount) {
          continue;
        }
        if (needsKeyword && !isNearby(spans, match.index, opts.window)) continue;

        const lo = Math.max(0, match.index - opts.window);
        const hi = Math.min(text.length, match.index + match[0].length + opts.window);
        const snippet = text.slice(lo, hi);

        const { score, reasons } = scoreText(snippet);
        if (score < opts.minScore) continue;

        const hit = {
          amount,
          score,
          reasons,
          code: findCode(snippet),
          timeLimitMin: findTimeLimit(snippet),
          snippet: snippet.replace(/\s+/g, ' ').trim().slice(0, 300),
          source: opts.source,
          url: opts.url,
          frameUrl: opts.frameUrl,
        };
        const previous = hits.get(amount);
        if (!previous || isBetter(hit, previous)) hits.set(amount, hit);
      }
    }

    return Array.from(hits.values()).sort((a, b) => b.amount - a.amount);
  }

  function isBetter(candidate, current) {
    if (candidate.score !== current.score) return candidate.score > current.score;
    return !current.code && !!candidate.code;
  }

  /** 同じ金額のヒットをまとめる。ブラウザ内なので browser は含めない。 */
  function signature(hit) {
    return String(hit.amount);
  }

  const CouponDetector = {
    STRONG_KEYWORDS,
    WEAK_KEYWORDS,
    SCORE_RULES,
    scanText,
    scoreText,
    findCode,
    findTimeLimit,
    toInt,
    signature,
  };

  root.CouponDetector = CouponDetector;
  if (typeof module !== 'undefined' && module.exports) module.exports = CouponDetector;
})(typeof globalThis !== 'undefined' ? globalThis : this);
