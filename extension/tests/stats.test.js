const test = require('node:test');
const assert = require('node:assert');
const Stats = require('../src/stats.js');

function at(hour, browser, detected, amount) {
  return {
    t: new Date(2026, 8, 9, hour, 0).getTime(),  // 2026-09-09 は水曜
    browser,
    target: 'トップページ',
    url: 'https://travel.yahoo.co.jp/',
    detected,
    amount: detected ? amount : null,
    score: detected ? 11 : 0,
    reasons: detected ? 'スペシャルクーポン' : '',
  };
}

const entries = [
  at(10, 'edge', true, 5000),
  at(10, 'edge', false),
  at(22, 'edge', true, 3000),
  at(22, 'edge', false),
  at(10, 'chrome', false),
  at(10, 'chrome', false),
  at(22, 'chrome', false),
  at(22, 'chrome', false),
];

test('ブラウザ別の出現率を分母つきで出す', () => {
  const result = Object.fromEntries(Stats.summarize(entries, 'browser').map((r) => [r.bucket, r]));
  assert.strictEqual(result.edge.checks, 4);
  assert.strictEqual(result.edge.hits, 2);
  assert.strictEqual(result.edge.rate, 50);
  assert.strictEqual(result.chrome.rate, 0);
});

test('出現率の高い順に並ぶ', () => {
  assert.strictEqual(Stats.summarize(entries, 'browser')[0].bucket, 'edge');
});

test('時間帯別に集計する', () => {
  const result = Object.fromEntries(Stats.summarize(entries, 'hour').map((r) => [r.bucket, r]));
  assert.strictEqual(result['10時台'].checks, 4);
  assert.strictEqual(result['10時台'].hits, 1);
  assert.strictEqual(result['22時台'].hits, 1);
});

test('曜日別に集計する', () => {
  const result = Stats.summarize(entries, 'weekday');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].bucket, '水');
  assert.strictEqual(result[0].checks, 8);
});

test('金額別の検出回数', () => {
  assert.deepStrictEqual(Stats.amountCounts(entries), [
    { amount: 5000, count: 1 },
    { amount: 3000, count: 1 },
  ]);
});

test('全体像と、標本が小さいことの警告', () => {
  const view = Stats.overview(entries);
  assert.strictEqual(view.total, 8);
  assert.strictEqual(view.detected, 2);
  assert.strictEqual(view.rate, 25);
  assert.strictEqual(view.reliable, false);   // 検出30件未満は「偶然の範囲」
});

test('検出が30件を超えたら傾向として読める', () => {
  const many = Array.from({ length: 30 }, () => at(10, 'edge', true, 5000));
  assert.strictEqual(Stats.overview(many).reliable, true);
});

test('履歴が空でも壊れない', () => {
  assert.deepStrictEqual(Stats.summarize([], 'browser'), []);
  assert.strictEqual(Stats.overview([]).total, 0);
  assert.strictEqual(Stats.overview([]).rate, 0);
});

test('CSVに書き出せる', () => {
  const csv = Stats.toCsv(entries.slice(0, 2));
  const lines = csv.split('\n');
  assert.ok(lines[0].startsWith('timestamp,date,weekday,hour,browser'));
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[1].includes('edge'));
  assert.ok(lines[1].includes('5000'));
});

test('CSVでカンマや引用符を含む値を壊さない', () => {
  const csv = Stats.toCsv([
    Object.assign(at(10, 'edge', true, 5000), { target: 'あ,い"う' }),
  ]);
  assert.ok(csv.includes('"あ,い""う"'));
});
