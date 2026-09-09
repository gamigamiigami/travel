const test = require('node:test');
const assert = require('node:assert');
const Settings = require('../src/settings.js');

test('Yahoo!トラベル配下だけを許可する', () => {
  for (const url of [
    'https://travel.yahoo.co.jp/',
    'https://travel.yahoo.co.jp/dp/hotel-12345/',
    'https://www.travel.yahoo.co.jp/domestic/area/tokyo/',
  ]) {
    assert.ok(Settings.isAllowedUrl(url), url);
  }
});

test('外部サイトと、予約・決済・アカウント操作系は踏まない', () => {
  for (const url of [
    'https://shopping.yahoo.co.jp/',
    'https://example.com/travel.yahoo.co.jp',
    'https://travel.yahoo.co.jp/dp/hotel-1/reserve/',
    'https://travel.yahoo.co.jp/booking/step1',
    'https://travel.yahoo.co.jp/payment/',
    'https://travel.yahoo.co.jp/mypage/',
    'https://login.yahoo.co.jp/config/login',
    'javascript:void(0)',
    'not a url',
  ]) {
    assert.ok(!Settings.isAllowedUrl(url), url);
  }
});

test('宿の詳細ページを優先して選ぶ', () => {
  const links = Array(5).fill('https://travel.yahoo.co.jp/help/');
  links.push('https://travel.yahoo.co.jp/dp/hotel-999/');
  let hotel = 0;
  for (let i = 0; i < 2000; i++) {
    if (Settings.pickWeighted(links).includes('/dp/')) hotel++;
  }
  // 重み4倍 → 一般リンク5本(重み1)に対して 4/9 ≒ 44% が期待値
  const rate = hotel / 2000;
  assert.ok(rate > 0.3 && rate < 0.6, `期待から外れています: ${rate}`);
});

test('候補が無いときは null', () => {
  assert.strictEqual(Settings.pickWeighted([]), null);
});

test('停止時間帯の判定', () => {
  const settings = { quietStartHour: 1, quietEndHour: 7 };
  const at = (hour) => new Date(2026, 0, 1, hour, 30);
  assert.strictEqual(Settings.inQuietHours(settings, at(0)), false);
  assert.strictEqual(Settings.inQuietHours(settings, at(3)), true);
  assert.strictEqual(Settings.inQuietHours(settings, at(7)), false);
  assert.strictEqual(Settings.inQuietHours(settings, at(12)), false);
});

test('日をまたぐ停止時間帯', () => {
  const settings = { quietStartHour: 23, quietEndHour: 5 };
  const at = (hour) => new Date(2026, 0, 1, hour, 30);
  assert.strictEqual(Settings.inQuietHours(settings, at(23)), true);
  assert.strictEqual(Settings.inQuietHours(settings, at(2)), true);
  assert.strictEqual(Settings.inQuietHours(settings, at(12)), false);
});

test('開始と終了が同じなら停止しない', () => {
  assert.strictEqual(Settings.inQuietHours({ quietStartHour: 0, quietEndHour: 0 }), false);
});

test('トピック名は毎回違い、推測しにくい長さがある', () => {
  const a = Settings.randomTopic();
  const b = Settings.randomTopic();
  assert.notStrictEqual(a, b);
  assert.ok(a.length >= 16, a);
  assert.ok(/^yt-coupon-/.test(a));
});

test('ブラウザを見分ける', () => {
  assert.strictEqual(Settings.browserName('Mozilla/5.0 Chrome/120.0 Edg/120.0'), 'edge');
  assert.strictEqual(Settings.browserName('Mozilla/5.0 Chrome/120.0 Safari/537'), 'chrome');
});

test('検索キーワードの既定値が入っている', () => {
  assert.ok(Settings.DEFAULTS.searchEnabled);
  assert.ok(Settings.DEFAULTS.searchKeywords.length >= 10);
  assert.ok(Settings.DEFAULTS.searchKeywords.includes('箱根'));
});
