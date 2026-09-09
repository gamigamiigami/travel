/** 履歴から出現率を集計する。検出しなかった回も分母に入れる。 */
(function (root) {
  'use strict';

  const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

  function bucketOf(entry, key) {
    const date = new Date(entry.t);
    if (key === 'browser') return entry.browser || '不明';
    if (key === 'weekday') return WEEKDAY_JA[date.getDay()];
    if (key === 'hour') return String(date.getHours()).padStart(2, '0') + '時台';
    if (key === 'target') return entry.target || '(不明)';
    throw new Error('未対応の集計軸: ' + key);
  }

  function summarize(entries, key) {
    const checks = new Map();
    const hits = new Map();
    for (const entry of entries) {
      const bucket = bucketOf(entry, key);
      checks.set(bucket, (checks.get(bucket) || 0) + 1);
      if (entry.detected) hits.set(bucket, (hits.get(bucket) || 0) + 1);
    }
    return Array.from(checks.entries())
      .map(([bucket, total]) => {
        const hit = hits.get(bucket) || 0;
        return { bucket, checks: total, hits: hit, rate: (100 * hit) / total };
      })
      .sort((a, b) => b.rate - a.rate || a.bucket.localeCompare(b.bucket));
  }

  function amountCounts(entries) {
    const counts = new Map();
    for (const entry of entries) {
      if (entry.detected && entry.amount) {
        counts.set(entry.amount, (counts.get(entry.amount) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([amount, count]) => ({ amount, count }))
      .sort((a, b) => b.count - a.count);
  }

  function overview(entries) {
    const total = entries.length;
    const detected = entries.filter((e) => e.detected).length;
    const days = new Set(entries.map((e) => new Date(e.t).toDateString())).size;
    return {
      total,
      detected,
      days,
      rate: total ? (100 * detected) / total : 0,
      // 標本が小さいうちの差は偶然。読み手が勘違いしないように明示する。
      reliable: detected >= 30,
    };
  }

  function toCsv(entries) {
    const header = ['timestamp', 'date', 'weekday', 'hour', 'browser', 'target', 'url', 'detected', 'amount', 'score', 'reasons'];
    const rows = entries.map((entry) => {
      const date = new Date(entry.t);
      return [
        date.toISOString(),
        date.toLocaleDateString('sv-SE'),
        WEEKDAY_JA[date.getDay()],
        date.getHours(),
        entry.browser || '',
        entry.target || '',
        entry.url || '',
        entry.detected ? 1 : 0,
        entry.amount == null ? '' : entry.amount,
        entry.score == null ? '' : entry.score,
        entry.reasons || '',
      ];
    });
    const escape = (value) => {
      const text = String(value);
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
  }

  const Stats = { WEEKDAY_JA, summarize, amountCounts, overview, toCsv, bucketOf };
  root.Stats = Stats;
  if (typeof module !== 'undefined' && module.exports) module.exports = Stats;
})(typeof globalThis !== 'undefined' ? globalThis : this);
