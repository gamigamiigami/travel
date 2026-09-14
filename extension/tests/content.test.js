const test = require('node:test');
const assert = require('node:assert');
const { FakeElement, loadContentScript } = require('./helpers/fake-dom.js');

// vm の中で作られた配列やオブジェクトは、host 側とは別の realm のものになる。
// deepStrictEqual は prototype の同一性まで見るので、素の値に落としてから比べる。
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * onMessage に投げて返事を受け取る。
 *
 * 実際のブラウザでは、切り離された古いスクリプトの受け口は呼ばれない。
 * ここでも最後に登録されたもの（＝生きている版）だけに聞く。
 */
function ask(env, message) {
  const listener = env.listeners[env.listeners.length - 1];
  return new Promise((resolve) => {
    let answered = false;
    const kept = listener(message, {}, (response) => {
      answered = true;
      resolve(response);
    });
    if (kept) {
      setTimeout(() => {
        if (!answered) resolve(null);
      }, 50);
    }
  });
}

const badge = (text = '残176分') =>
  new FakeElement({ className: 'popup-badge-p2', text });

const panel = (text) => new FakeElement({ className: 'popup-panel', text });

test('content.js が実行時エラーなく読み込める', async () => {
  // 変数の宣言漏れなどは構文チェックでは見つからない。実際に走らせて確かめる。
  const env = loadContentScript({ elements: [badge()] });
  await env.ready();
  assert.strictEqual(env.listeners.length, 1);
  assert.deepStrictEqual(plain(env.warnings), []);
});

test('起動時に設定を取りに行く', async () => {
  const env = loadContentScript({ elements: [badge()] });
  await env.ready();
  assert.ok(env.sent.some((m) => m.type === 'getSettings'));
});

test('MutationObserver 経由の走査が例外にならない', async () => {
  // ここは debounceTimer を使う経路。宣言が無いと ReferenceError になる。
  const env = loadContentScript({ elements: [badge()] });
  await env.ready();
  env.runTimers(100);
  assert.doesNotThrow(() => env.context.__observer.callback([]));
  assert.doesNotThrow(() => env.runTimers());
});

test('カウントダウンのバッジだけでクーポンを検出して通知する', async () => {
  const env = loadContentScript({ elements: [badge('残176分')] });
  await env.ready();
  env.runTimers(1000);
  const coupons = env.sent.filter((m) => m.type === 'coupon');
  assert.strictEqual(coupons.length, 1);
  assert.strictEqual(coupons[0].hit.amount, null);
  assert.strictEqual(coupons[0].hit.timeLimitMin, 176);
  assert.strictEqual(coupons[0].hit.source, 'badge');
});

test('scan に返す hits にもバッジ由来のヒットが入る', async () => {
  const env = loadContentScript({ elements: [badge('残176分')] });
  await env.ready();
  const response = await ask(env, { type: 'scan' });
  assert.ok(response && response.ok);
  assert.strictEqual(response.hits.length, 1);
  assert.strictEqual(response.hits[0].timeLimitMin, 176);
});

test('パネルが出ていれば金額つきで検出する', async () => {
  const env = loadContentScript({
    elements: [
      badge('残176分'),
      panel('使うor貯めるが選べる！\n2,000円分\nクーポン獲得しました\n詳しくみる'),
    ],
  });
  await env.ready();
  const response = await ask(env, { type: 'scan' });
  assert.deepStrictEqual(plain(response.hits.map((h) => h.amount)), [2000]);
});

test('カウントダウンが無ければ宿ごとのクーポンとして見送る', async () => {
  const env = loadContentScript({
    elements: [panel('この宿で使える割引クーポン 3,000円OFF')],
  });
  await env.ready();
  const response = await ask(env, { type: 'scan' });
  assert.deepStrictEqual(plain(response.hits), []);
  assert.ok(
    env.sent.some((m) => m.type === 'skipped'),
    '見送った理由を報告しているはず'
  );
});

test('クーポンが無ければ何も通知しない', async () => {
  const env = loadContentScript({
    elements: [panel('人気の温泉宿ランキング 1泊 5,000円から')],
  });
  await env.ready();
  const response = await ask(env, { type: 'scan' });
  assert.deepStrictEqual(plain(response.hits), []);
  assert.ok(!env.sent.some((m) => m.type === 'coupon'));
});

test('180分を超えるカウントダウンはクーポンとみなさない', async () => {
  const env = loadContentScript({ elements: [badge('残600分')] });
  await env.ready();
  const response = await ask(env, { type: 'scan' });
  assert.deepStrictEqual(plain(response.hits), []);
});

test('リンク一覧を返せる', async () => {
  const env = loadContentScript({
    elements: [
      new FakeElement({ tag: 'a', attrs: { href: 'https://travel.yahoo.co.jp/00916717/' } }),
      new FakeElement({ tag: 'a', attrs: { href: '#top' } }),
    ],
  });
  await env.ready();
  const response = await ask(env, { type: 'links' });
  assert.ok(response.ok);
  assert.deepStrictEqual(plain(response.links.map((l) => l.url)), [
    'https://travel.yahoo.co.jp/00916717/',
  ]);
});

test('拡張が切り離されていても例外を投げない', async () => {
  // 拡張を更新したあと、開きっぱなしのタブで起きる状況。
  const env = loadContentScript({ elements: [badge()], runtimeAlive: false });
  await env.ready();
  assert.doesNotThrow(() => env.runTimers());
  assert.deepStrictEqual(
    plain(env.sent.filter((m) => m.type === 'coupon')),
    [],
    '切り離されているので何も送らない'
  );
});

test('Yahoo!トラベル以外のフレームでは何もしない', async () => {
  const env = loadContentScript({
    url: 'https://mail.yahoo.co.jp/inbox',
    elements: [badge('残100分')],
  });
  await env.ready();
  assert.strictEqual(env.listeners.length, 0, 'リスナーすら登録しない');
  assert.deepStrictEqual(plain(env.sent), []);
});

test('同じ版が生きているうちは二重に起動しない', async () => {
  const env = loadContentScript({ elements: [badge()] });
  await env.ready();
  assert.strictEqual(env.listeners.length, 1);

  env.injectAgain();
  await env.ready();
  assert.strictEqual(env.listeners.length, 1, '受け口が二重に登録されてはいけない');
});

test('古い版が死んでいたら新しい版が引き継ぐ', async () => {
  // 拡張を更新したあとの状況。古いスクリプトは切り離されて死んでいる。
  const env = loadContentScript({ elements: [badge()] });
  await env.ready();
  assert.strictEqual(env.listeners.length, 1);

  // 本体との接続が切れる（拡張の更新）
  env.context.chrome.runtime.id = undefined;
  env.context.__observer.callback([]); // 古い版が切断に気づく
  env.runTimers();

  // popup が新しい版を注入し直す
  env.injectAgain({ runtimeAlive: true });
  await env.ready();
  assert.strictEqual(
    env.listeners.length,
    2,
    '新しい版が受け口を登録できないと、ページが永久に無反応になる'
  );
});

test('引き継いだあと新しい版でちゃんと検出できる', async () => {
  const env = loadContentScript({ elements: [badge('残176分')] });
  await env.ready();

  env.context.chrome.runtime.id = undefined;
  env.context.__observer.callback([]);
  env.runTimers();

  env.injectAgain({ runtimeAlive: true });
  await env.ready();

  const response = await ask(env, { type: 'scan' });
  assert.ok(response && response.ok, '新しい版が応答できるはず');
  assert.strictEqual(response.hits.length, 1);
});
