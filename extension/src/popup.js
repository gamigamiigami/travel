'use strict';

const $ = (id) => document.getElementById(id);

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
  element.textContent = message;
  element.className = 'status show ' + (ok ? 'ok' : 'ng');
}

async function render() {
  const settings = await Settings.getSettings();
  $('enabled').checked = !!settings.enabled;

  const store = await chrome.storage.local.get(['daily', 'lastPatrolAt', 'nextPatrolAt', 'lastHit']);
  const used = store.daily && store.daily.date === new Date().toISOString().slice(0, 10)
    ? store.daily.count : 0;
  const limit = settings.maxPatrolsPerDay > 0 ? ` / ${settings.maxPatrolsPerDay}` : '';
  $('daily').textContent = `${used}${limit} 回`;
  $('last').textContent = when(store.lastPatrolAt);
  $('next').textContent = settings.patrolEnabled ? when(store.nextPatrolAt) : '自動巡回オフ';
  $('hit').textContent = store.lastHit
    ? `${store.lastHit.amount.toLocaleString()}円 (${when(store.lastHit.t)})`
    : 'まだなし';
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
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/detector.js', 'src/content.js'],
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

document.addEventListener('DOMContentLoaded', async () => {
  await render();

  $('enabled').addEventListener('change', async () => {
    await Settings.saveSettings({ enabled: $('enabled').checked });
    await chrome.runtime.sendMessage({ type: 'rescheduleAlarm' }).catch(() => {});
    await render();
  });

  $('now').addEventListener('click', async () => {
    show('巡回中です。バックグラウンドのタブで見に行っています…', true);
    await chrome.runtime.sendMessage({ type: 'patrolNow' }).catch(() => {});
    show('巡回が終わりました。', true);
    await render();
  });

  $('scan').addEventListener('click', async () => {
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
    show(
      hits.length
        ? `${hits.map((h) => h.amount.toLocaleString() + '円').join('・')} を検出しました`
        : 'いまはクーポンを検出できませんでした。（普段はこれが正常です）',
      hits.length > 0
    );
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
});
