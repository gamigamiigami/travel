/**
 * 拡張本体との通信。「切り離された状態」を安全に扱う。
 *
 * 拡張を更新・再読み込みすると、既に開いていたページで動いている古い
 * content script は本体から切り離される（Extension context invalidated）。
 * この状態の chrome.runtime.sendMessage は Promise を返さず、その場で例外を
 * 投げる。つまり .catch() では捕まえられない。
 *
 * さらに、切り離された script が MutationObserver で動き続けると、
 * ページを開いている間ずっとコンソールに例外を吐き続ける。一度切れたら
 * 静かに止まるのが正しい。
 */
(function (root) {
  'use strict';

  function createMessenger(options) {
    const getRuntime = (options && options.getRuntime) || (() => null);
    const onLost = (options && options.onLost) || function () {};
    let lost = false;

    function isAlive() {
      if (lost) return false;
      try {
        const runtime = getRuntime();
        // 切り離されると runtime.id が消える。これが唯一の確実な目印。
        return !!(runtime && runtime.id);
      } catch (e) {
        return false;
      }
    }

    function giveUp() {
      if (lost) return;
      lost = true;
      try {
        onLost();
      } catch (e) {
        /* 後始末に失敗しても、止まること自体は達成されている */
      }
    }

    function send(message) {
      if (!isAlive()) {
        giveUp();
        return Promise.resolve(null);
      }
      let result;
      try {
        result = getRuntime().sendMessage(message);
      } catch (e) {
        giveUp();
        return Promise.resolve(null);
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => value,
          () => {
            giveUp();
            return null;
          }
        );
      }
      return Promise.resolve(result);
    }

    return {
      isAlive,
      giveUp,
      send,
      get lost() {
        return lost;
      },
    };
  }

  const Messaging = { createMessenger };
  root.Messaging = Messaging;
  if (typeof module !== 'undefined' && module.exports) module.exports = Messaging;
})(typeof globalThis !== 'undefined' ? globalThis : this);
