const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/detector.js');

const scan = (text, opts) => D.scanText(text, Object.assign({ minScore: 0 }, opts));
const amounts = (hits) => hits.map((h) => h.amount);

test('ポップアップの典型パターンを検出する', () => {
  const hits = scan('スペシャルクーポン\n5,000円OFF\n残り180分限定');
  assert.deepStrictEqual(amounts(hits), [5000]);
  assert.strictEqual(hits[0].timeLimitMin, 180);
});

test('金額の表記ゆれをすべて拾う', () => {
  const cases = [
    ['スペシャルクーポン 1,000円OFF', 1000],
    ['スペシャルクーポン 3000円OFF', 3000],
    ['スペシャルクーポン ２，０００円オフ', 2000],
    ['限定クーポン 3000円割引', 3000],
    ['あなただけのクーポン 50,000円OFF', 50000],
  ];
  for (const [text, expected] of cases) {
    assert.deepStrictEqual(amounts(scan(text)), [expected], text);
  }
});

test('OFFが付かない「5,000円クーポン」形式も拾う', () => {
  assert.deepStrictEqual(amounts(scan('いまなら5,000円クーポンをプレゼント')), [5000]);
});

test('60分・90分・180分すべてを有効時間として認識する', () => {
  for (const minutes of [60, 90, 180]) {
    const hits = scan(`5,000円OFFクーポン 残り${minutes}分`, { strict: false });
    assert.strictEqual(hits[0].timeLimitMin, minutes);
    assert.ok(hits[0].reasons.includes(`${minutes}分限定`));
  }
});

test('クーポンと無関係な金額は拾わない', () => {
  assert.deepStrictEqual(scan('本日限り 5,000円OFF の宿はこちら'), []);
});

test('キーワードが遠すぎる金額は拾わない', () => {
  const text = 'スペシャルクーポンについて' + 'あ'.repeat(500) + '宿泊料金 5,000円OFF';
  assert.deepStrictEqual(scan(text), []);
});

test('宿の価格をクーポン額と取り違えない', () => {
  const text = 'スペシャルクーポン配布中！ このホテル 1泊 5,000円 から';
  assert.deepStrictEqual(scan(text, { strict: false }), []);
});

test('strictはSTRONGキーワードのみ、非strictは弱いキーワードも許す', () => {
  const text = 'クーポン 3,000円OFF';
  assert.deepStrictEqual(scan(text, { strict: true }), []);
  assert.deepStrictEqual(amounts(scan(text, { strict: false })), [3000]);
});

test('minScoreで足切りできる', () => {
  const text = 'クーポン 3,000円OFF';
  assert.ok(scan(text, { strict: false, minScore: 0 }).length > 0);
  assert.deepStrictEqual(scan(text, { strict: false, minScore: 99 }), []);
});

test('金額の下限・上限が効く', () => {
  assert.deepStrictEqual(scan('スペシャルクーポン 500円OFF'), []);
  assert.deepStrictEqual(amounts(scan('スペシャルクーポン 500円OFF', { minAmount: 100 })), [500]);
});

test('ホワイトリストで金額を絞れる', () => {
  const text = 'スペシャルクーポン 1,500円OFF';
  assert.deepStrictEqual(scan(text, { amountsWhitelist: [1000, 3000] }), []);
  assert.deepStrictEqual(amounts(scan(text, { amountsWhitelist: [1500] })), [1500]);
});

test('ignorePatternsで既知の誤検知を黙らせられる', () => {
  const text = 'ヤフーパックで使えるクーポン スペシャルクーポン 5,000円OFF';
  assert.deepStrictEqual(scan(text, { ignorePatterns: ['ヤフーパックで使える'] }), []);
  assert.deepStrictEqual(scan(text, { ignorePatterns: ['('] }).length > 0, true); // 壊れた正規表現は無視
});

test('クーポンコードを抜き出す', () => {
  const hits = scan('スペシャルクーポン 5,000円OFF クーポンコード YT5000AB を利用');
  assert.strictEqual(hits[0].code, 'YT5000AB');
});

test('高額から順に並ぶ', () => {
  const text = 'スペシャルクーポン 1,000円OFF と スペシャルクーポン 5,000円OFF';
  assert.deepStrictEqual(amounts(scan(text)), [5000, 1000]);
});

test('同じ金額ならスコアが高い方を残す', () => {
  const text =
    'クーポン 5,000円OFF' + '。'.repeat(400) +
    'スペシャルクーポン 5,000円OFF 残り180分限定 コード AB12CD34';
  const hits = scan(text, { strict: false });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].code, 'AB12CD34');
});

test('スコアと根拠が付く', () => {
  const { score, reasons } = D.scoreText('スペシャルクーポン 5,000円OFF 残り180分');
  assert.ok(score >= 7);
  assert.ok(reasons.includes('スペシャルクーポン'));
  assert.ok(reasons.includes('180分限定'));
});

test('ただの言及はスコアが低い', () => {
  assert.ok(D.scoreText('クーポンについてのご案内').score <= 2);
});

test('正規表現の状態が呼び出し間で漏れない', () => {
  const text = 'スペシャルクーポン 5,000円OFF';
  for (let i = 0; i < 5; i++) {
    assert.deepStrictEqual(amounts(scan(text)), [5000], `${i}回目`);
  }
});
