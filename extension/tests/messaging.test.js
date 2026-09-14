const test = require('node:test');
const assert = require('node:assert');
const Messaging = require('../src/messaging.js');

/** 生きている拡張のふり。 */
function aliveRuntime(sendImpl) {
  return {
    id: 'abcdef',
    sendMessage: sendImpl || (() => Promise.resolve({ ok: true })),
  };
}

/** 切り離された拡張のふり。sendMessage はその場で例外を投げる。 */
function deadRuntime() {
  return {
    id: undefined,
    sendMessage() {
      throw new Error('Extension context invalidated.');
    },
  };
}

test('生きているときは普通に送れる', async () => {
  const messenger = Messaging.createMessenger({ getRuntime: () => aliveRuntime() });
  assert.strictEqual(messenger.isAlive(), true);
  assert.deepStrictEqual(await messenger.send({ type: 'x' }), { ok: true });
  assert.strictEqual(messenger.lost, false);
});

test('切り離されていたら送らずに null を返す', async () => {
  const messenger = Messaging.createMessenger({ getRuntime: () => deadRuntime() });
  assert.strictEqual(messenger.isAlive(), false);
  assert.strictEqual(await messenger.send({ type: 'x' }), null);
  assert.strictEqual(messenger.lost, true);
});

test('sendMessage がその場で例外を投げても外に漏らさない', async () => {
  // ここが本題。切り離された sendMessage は Promise を返さず同期で throw するので
  // .catch() では捕まえられない。
  let runtime = aliveRuntime(() => {
    throw new Error('Extension context invalidated.');
  });
  const messenger = Messaging.createMessenger({ getRuntime: () => runtime });
  assert.strictEqual(await messenger.send({ type: 'x' }), null);
  assert.strictEqual(messenger.lost, true);
});

test('Promise が拒否された場合も飲み込む', async () => {
  const messenger = Messaging.createMessenger({
    getRuntime: () => aliveRuntime(() => Promise.reject(new Error('受け手がいません'))),
  });
  assert.strictEqual(await messenger.send({ type: 'x' }), null);
  assert.strictEqual(messenger.lost, true);
});

test('切り離されたら後始末が1回だけ呼ばれる', async () => {
  let cleanups = 0;
  const messenger = Messaging.createMessenger({
    getRuntime: () => deadRuntime(),
    onLost: () => {
      cleanups++;
    },
  });
  await messenger.send({ type: 'a' });
  await messenger.send({ type: 'b' });
  await messenger.send({ type: 'c' });
  assert.strictEqual(cleanups, 1, '何度も後始末を走らせない');
});

test('一度切れたら以降は本体に触らない', async () => {
  let calls = 0;
  const runtime = {
    get id() {
      calls++;
      throw new Error('Extension context invalidated.');
    },
  };
  const messenger = Messaging.createMessenger({ getRuntime: () => runtime });
  await messenger.send({ type: 'a' });
  const afterFirst = calls;
  await messenger.send({ type: 'b' });
  await messenger.send({ type: 'c' });
  assert.strictEqual(calls, afterFirst, '切れたあとは触りにいかない');
});

test('後始末が失敗しても止まること自体は達成される', async () => {
  const messenger = Messaging.createMessenger({
    getRuntime: () => deadRuntime(),
    onLost: () => {
      throw new Error('後始末に失敗');
    },
  });
  assert.strictEqual(await messenger.send({ type: 'x' }), null);
  assert.strictEqual(messenger.lost, true);
});

test('runtime が取れなくても例外にしない', async () => {
  const messenger = Messaging.createMessenger({});
  assert.strictEqual(messenger.isAlive(), false);
  assert.strictEqual(await messenger.send({ type: 'x' }), null);
});
