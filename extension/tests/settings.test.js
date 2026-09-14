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
  const links = Array(5).fill('https://travel.yahoo.co.jp/list/');
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

// ------------------------------------------------------- 高価格帯の宿の優先

const EXPENSIVE = { preferExpensive: true, minHotelPrice: 25000 };

test('閾値以上の宿だけを選ぶ', () => {
  const items = [
    { url: 'https://travel.yahoo.co.jp/dp/cheap/', price: 8000 },
    { url: 'https://travel.yahoo.co.jp/dp/rich/', price: 32000 },
    { url: 'https://travel.yahoo.co.jp/help/', price: null },
  ];
  for (let i = 0; i < 200; i++) {
    assert.strictEqual(Settings.pickLink(items, EXPENSIVE).url, 'https://travel.yahoo.co.jp/dp/rich/');
  }
});

test('ちょうど閾値の宿は対象に含む', () => {
  const items = [
    { url: 'https://travel.yahoo.co.jp/dp/a/', price: 24999 },
    { url: 'https://travel.yahoo.co.jp/dp/b/', price: 25000 },
  ];
  assert.strictEqual(Settings.pickLink(items, EXPENSIVE).price, 25000);
});

test('高価格帯が無ければ通常の選び方に戻る', () => {
  const items = [
    { url: 'https://travel.yahoo.co.jp/dp/cheap/', price: 8000 },
    { url: 'https://travel.yahoo.co.jp/help/', price: null },
  ];
  const picked = Settings.pickLink(items, EXPENSIVE);
  assert.ok(picked);
  assert.ok(items.some((i) => i.url === picked.url));
});

test('優先をオフにすれば価格を見ない', () => {
  const items = [
    { url: 'https://travel.yahoo.co.jp/dp/cheap/', price: 8000 },
    { url: 'https://travel.yahoo.co.jp/dp/rich/', price: 99000 },
  ];
  const urls = new Set();
  for (let i = 0; i < 300; i++) {
    urls.add(Settings.pickLink(items, { preferExpensive: false }).url);
  }
  assert.strictEqual(urls.size, 2, '両方が選ばれるはず');
});

test('踏んではいけないURLは価格が高くても除外する', () => {
  const items = [
    { url: 'https://travel.yahoo.co.jp/dp/a/reserve/', price: 99000 },
    { url: 'https://shopping.yahoo.co.jp/', price: 99000 },
    { url: 'https://travel.yahoo.co.jp/dp/ok/', price: 30000 },
  ];
  assert.strictEqual(Settings.pickLink(items, EXPENSIVE).url, 'https://travel.yahoo.co.jp/dp/ok/');
});

test('文字列の配列でも受け付ける（後方互換）', () => {
  const picked = Settings.pickLink(['https://travel.yahoo.co.jp/dp/a/'], EXPENSIVE);
  assert.strictEqual(picked.url, 'https://travel.yahoo.co.jp/dp/a/');
});

test('候補が無ければ null', () => {
  assert.strictEqual(Settings.pickLink([], EXPENSIVE), null);
  assert.strictEqual(Settings.pickLink([{ url: 'https://example.com/' }], EXPENSIVE), null);
});


test('宿が並ばないページは選ばれにくくする', () => {
  // 観光情報やヘルプに潜っても宿は出てこないので、巡回として無駄になる。
  const links = ['https://travel.yahoo.co.jp/kanko/kanazawa/', 'https://travel.yahoo.co.jp/list/'];
  let kanko = 0;
  for (let i = 0; i < 2000; i++) {
    if (Settings.pickWeighted(links).includes('/kanko/')) kanko++;
  }
  const rate = kanko / 2000;
  assert.ok(rate < 0.25, `観光ページが選ばれすぎています: ${rate}`);
});

test('宿の詳細ページは避けるページより強い', () => {
  assert.ok(
    Settings.linkWeight('https://travel.yahoo.co.jp/dp/a/') >
      Settings.linkWeight('https://travel.yahoo.co.jp/list/')
  );
  assert.ok(
    Settings.linkWeight('https://travel.yahoo.co.jp/list/') >
      Settings.linkWeight('https://travel.yahoo.co.jp/kanko/a/')
  );
});

test('既定でスペシャルクーポンの条件に絞られている', () => {
  assert.deepStrictEqual(Settings.DEFAULTS.amountsWhitelist, [1000, 2000, 3000, 5000]);
  assert.strictEqual(Settings.DEFAULTS.requireCountdown, true);
  assert.strictEqual(Settings.DEFAULTS.maxTimeLimitMin, 180);
});

test('クーポンのバッジが出るページを厚く選ぶ', () => {
  const weight = Settings.linkWeight;
  // 診断データで、バッジは宿の詳細と検索結果には出ていたが
  // テーマページには出ていなかった。
  const hotelDp = weight('https://travel.yahoo.co.jp/dp/hotel-1/');
  const hotelNumeric = weight('https://travel.yahoo.co.jp/00916717/?cid=1');
  const search = weight('https://travel.yahoo.co.jp/search?cid=1');
  const theme = weight('https://travel.yahoo.co.jp/area/ma000000/t4087/');
  const plain = weight('https://travel.yahoo.co.jp/list/');
  const kanko = weight('https://travel.yahoo.co.jp/kanko/kanazawa/');

  assert.strictEqual(hotelDp, hotelNumeric, '数字IDの宿ページも /dp/ と同じ扱い');
  assert.ok(hotelDp > theme);
  assert.ok(search > theme);
  assert.ok(theme > plain);
  assert.ok(plain > kanko);
});
