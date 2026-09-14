'use strict';

const $ = (id) => document.getElementById(id);

/** 要素が無くても落ちないようにする（古いファイルが混ざったとき用）。 */
function on(id, event, handler) {
  const element = $(id);
  if (!element) {
    console.warn('[クーポンウォッチャー] 要素が見つかりません:', id);
    return;
  }
  element.addEventListener(event, handler);
}

function setText(id, text) {
  const element = $(id);
  if (element) element.textContent = text;
}

function when(timestamp) {
  if (!timestamp) return '—';
  const diff = Date.now() - timestamp;
  const future = diff < 0;
  const minutes = Math.round(Math.abs(diff) / 60000);
  if (minutes < 1) return future ? 'まもなく' : 'たった今';
  if (minutes < 60) return future ? `約${minutes}分後` : `${minutes}分前`;
  const hours = Math.round(minutes / 60);
  return future ? `約${hours}時間後` : `${hours}時間前`;
}

function show(message, ok) {
  const element = $('status');
  if (!element) return;
  element.textContent = message;
  element.className = 'status show ' + (ok ? 'ok' : 'ng');
}

async function render() {
  const settings = await Settings.getSettings();
  if ($('enabled')) $('enabled').checked = !!settings.enabled;

  const store = await chrome.storage.local.get(['daily', 'lastPatrolAt', 'nextPatrolAt', 'lastHit']);
  const used = store.daily && store.daily.date === new Date().toISOString().slice(0, 10)
    ? store.daily.count : 0;
  const limit = settings.maxPatrolsPerDay > 0 ? ` / ${settings.maxPatrolsPerDay}` : '';
  setText('daily', `${used}${limit} 回`);
  setText('last', when(store.lastPatrolAt));
  setText('next', settings.patrolEnabled ? when(store.nextPatrolAt) : '自動巡回オフ');
  setText('hit', store.lastHit
    ? `${
        store.lastHit.amount ? store.lastHit.amount.toLocaleString() + '円' : '金額不明'
      } (${when(store.lastHit.t)})`
    : 'まだなし');
}

/**
 * ページを調べる。content script が入っていないタブ（拡張を入れる前から
 * 開いていたタブなど）でも動くよう、届かなければその場で注入して再試行する。
 */
async function scanTab(tabId) {
  const attempts = [
    () => chrome.tabs.sendMessage(tabId, { type: 'scan' }, { frameId: 0 }),
    () => chrome.tabs.sendMessage(tabId, { type: 'scan' }),
  ];
  let lastError = '応答なし';

  for (const attempt of attempts) {
    try {
      const response = await attempt();
      if (response) return { ok: true, hits: response.hits || [] };
      lastError = '応答が空でした';
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  // ここまで届かないなら content script が入っていない。注入して最後の再試行。
  try {
    // 読み込むファイルは manifest から取る。ここに手で並べると、
    // ファイルが増えたときに書き忘れて「注入したのに動かない」になる。
    const files = (chrome.runtime.getManifest().content_scripts || [])
      .flatMap((entry) => entry.js || []);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const response = await chrome.tabs.sendMessage(tabId, { type: 'scan' }, { frameId: 0 });
    if (response) return { ok: true, hits: response.hits || [] };
    lastError = '注入後も応答が空でした';
  } catch (e) {
    lastError = String((e && e.message) || e) + '（注入も失敗）';
  }
  return { ok: false, error: lastError };
}

function clockOf(timestamp) {
  const date = new Date(timestamp);
  return (
    String(date.getHours()).padStart(2, '0') + ':' +
    String(date.getMinutes()).padStart(2, '0')
  );
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function renderActivity() {
  const activity = (await chrome.storage.local.get('activity')).activity || [];
  const container = document.getElementById('activity');
  if (!container) return;
  const recent = activity.slice(-6).reverse();
  container.innerHTML = recent.length
    ? recent
        .map(
          (entry) =>
            `<div><time>${clockOf(entry.t)}</time>` +
            `<span class="${entry.level === 'hit' ? 'hit' : entry.level === 'warn' ? 'warn' : ''}">` +
            `${escapeHtml(entry.message)}</span></div>`
        )
        .join('')
    : 'まだ記録がありません';
}

document.addEventListener('DOMContentLoaded', async () => {
  await render();
  await renderActivity();

  on('enabled', 'change', async () => {
    await Settings.saveSettings({ enabled: $('enabled').checked });
    await chrome.runtime.sendMessage({ type: 'rescheduleAlarm' }).catch(() => {});
    await render();
  });

  on('now', 'click', async () => {
    show('巡回中です。裏のタブで見に行っています…', true);
    await chrome.runtime.sendMessage({ type: 'patrolNow' }).catch(() => {});
    show('巡回が終わりました。下の「最近の動き」で内容を確認できます。', true);
    await render();
    await renderActivity();
  });

  on('watch', 'click', async () => {
    // タブを表に出して巡回する。popup は閉じてしまうので、あとでログを見てもらう。
    show('タブを表示して巡回します。動きを見てください。', true);
    chrome.runtime.sendMessage({ type: 'patrolNow', visible: true }).catch(() => {});
  });

  on('scan', 'click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      show('タブを取得できませんでした。', false);
      return;
    }
    if (!Settings.isAllowedUrl(tab.url || '')) {
      show('Yahoo!トラベルのページを開いた状態で押してください。', false);
      return;
    }

    show('調べています…', true);
    const result = await scanTab(tab.id);
    if (!result.ok) {
      // 原因を握りつぶさず、そのまま出す。報告してもらえれば直せる。
      show('読み取れませんでした: ' + result.error, false);
      return;
    }
    const hits = result.hits || [];
    const describe = (h) =>
      h.amount
        ? h.amount.toLocaleString() + '円'
        : `金額不明${h.timeLimitMin ? `（残${h.timeLimitMin}分）` : ''}`;
    show(
      hits.length
        ? `${hits.map(describe).join('・')} を検出しました`
        : 'いまはクーポンを検出できませんでした。（普段はこれが正常です）',
      hits.length > 0
    );
  });

  on('reset', 'click', async () => {
    await chrome.runtime.sendMessage({ type: 'resetDedupe' }).catch(() => {});
    show('重複抑止をリセットしました。同じクーポンでももう一度通知します。', true);
    await renderActivity();
  });

  on('options', 'click', () => chrome.runtime.openOptionsPage());
});
