const test = require('node:test');
const assert = require('node:assert');
const { loadBackground, loadPage } = require('./helpers/fake-extension.js');

// ------------------------------------------------------------ background

test('background.js が実行時エラーなく読み込める', () => {
  const env = loadBackground();
  assert.strictEqual(env.listeners.message.length, 1);
  assert.strictEqual(env.listeners.alarm.length, 1);
  assert.deepStrictEqual(env.errors, []);
});

test('起動処理が通り、バージョンをログに残す', async () => {
  const env = loadBackground();
  for (const fn of env.listeners.installed) await fn();
  await env.settle();
  const messages = (env.storage.data.activity || []).map((a) => a.message);
  assert.ok(messages.some((m) => m.includes('起動しました')), messages.join(' / '));
  assert.deepStrictEqual(env.errors, []);
});

test('全てのメッセージを処理して例外を出さない', async () => {
  const env = loadBackground();
  for (const fn of env.listeners.installed) await fn();
  await env.settle();

  const messages = [
    { type: 'getSettings' },
    { type: 'testNotify' },
    { type: 'resetDedupe' },
    { type: 'rescheduleAlarm' },
    { type: 'scriptError', where: 'テスト', detail: 'TypeError: x' },
    { type: 'skipped', hit: { amount: 3000 }, reason: 'テスト' },
    { type: 'nearMiss', hit: { amount: 2000, score: 3, reasons: [] }, threshold: 4 },
    { type: 'patrolNow', visible: false },
    { type: '未知のメッセージ' },
  ];
  for (const message of messages) {
    await env.post(message);
    await env.settle();
  }
  assert.deepStrictEqual(env.errors, [], 'どのメッセージでも例外を出さない');
});

test('金額不明のクーポンも通知できる', async () => {
  const env = loadBackground();
  await env.post({
    type: 'coupon',
    hit: { amount: null, score: 99, timeLimitMin: 176, reasons: ['残り時間バッジ'], source: 'badge' },
    pageUrl: 'https://travel.yahoo.co.jp/',
  });
  await env.settle();
  const titles = env.calls.notifications.map((n) => n.options.title);
  assert.strictEqual(titles.length, 1);
  assert.ok(titles[0].includes('残176分'), titles[0]);
});

test('同じクーポンは二度通知せず、理由をログに残す', async () => {
  const env = loadBackground();
  const message = {
    type: 'coupon',
    hit: { amount: 2000, score: 14, timeLimitMin: 180, reasons: [], source: 'popup' },
    pageUrl: 'https://travel.yahoo.co.jp/',
  };
  await env.post(message);
  await env.settle();
  await env.post(message);
  await env.settle();

  assert.strictEqual(env.calls.notifications.length, 1, '通知は1回だけ');
  const messages = (env.storage.data.activity || []).map((a) => a.message);
  assert.ok(
    messages.some((m) => m.includes('通知済みのため見送り')),
    '黙って捨てると壊れているように見える'
  );
});

test('抑止をリセットすればもう一度通知する', async () => {
  const env = loadBackground();
  const message = {
    type: 'coupon',
    hit: { amount: 2000, score: 14, timeLimitMin: 180, reasons: [], source: 'popup' },
    pageUrl: 'https://travel.yahoo.co.jp/',
  };
  await env.post(message);
  await env.settle();
  await env.post({ type: 'resetDedupe' });
  await env.settle();
  await env.post(message);
  await env.settle();
  assert.strictEqual(env.calls.notifications.length, 2);
});

test('ntfy へは日本語をヘッダに載せず本文で送る', async () => {
  const env = loadBackground();
  // トピック名は初回起動時に自動生成される。それを済ませてから送る。
  for (const fn of env.listeners.installed) await fn();
  await env.settle();
  await env.post({ type: 'testNotify' });
  await env.settle();
  const call = env.calls.fetches.find((f) => String(f.url).includes('ntfy'));
  assert.ok(call, 'ntfy へ送っているはず');
  const headers = call.init.headers || {};
  for (const value of Object.values(headers)) {
    // 非ASCIIがヘッダに入ると送信自体が例外で落ちる
    assert.ok(/^[\x20-\x7e]*$/.test(String(value)), `ヘッダに非ASCII: ${value}`);
  }
  const body = JSON.parse(call.init.body);
  assert.ok(body.title.includes('クーポン'), '日本語は本文側に入る');
});

// ------------------------------------------------------- 設定画面 / popup

test('設定画面のスクリプトが HTML と食い違っていない', async () => {
  // JS が掴もうとする id が HTML に無いと、その場で画面全体が止まる。
  const env = loadPage('options.html', ['settings.js', 'stats.js', 'options.js']);
  await env.ready();
  assert.deepStrictEqual(env.warnings, [], env.warnings.join('\n'));
});

test('popup のスクリプトが HTML と食い違っていない', async () => {
  const env = loadPage('popup.html', ['settings.js', 'popup.js']);
  await env.ready();
  assert.deepStrictEqual(env.warnings, [], env.warnings.join('\n'));
});

test('設定画面はバージョンを表示する', async () => {
  const env = loadPage('options.html', ['settings.js', 'stats.js', 'options.js']);
  await env.ready();
  assert.strictEqual(env.elements.version.textContent, '0.0.0-test');
});
