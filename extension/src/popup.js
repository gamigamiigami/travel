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
    if (!tab || !Settings.isAllowedUrl(tab.url || '')) {
      show('Yahoo!トラベルのページを開いた状態で押してください。', false);
      return;
    }
    const response = await chrome.tabs
      .sendMessage(tab.id, { type: 'scan' }, { frameId: 0 })
      .catch(() => null);
    if (!response) {
      show('このページを読み取れませんでした。再読み込みしてから試してください。', false);
      return;
    }
    const hits = response.hits || [];
    show(
      hits.length
        ? `${hits.map((h) => h.amount.toLocaleString() + '円').join('・')} を検出しました`
        : 'いまはクーポンを検出できませんでした。',
      hits.length > 0
    );
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
});
