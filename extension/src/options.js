'use strict';

const CHECKBOXES = [
  'enabled', 'patrolEnabled', 'notifyDesktop', 'notifyNtfy', 'notifyDiscord', 'autoClaim',
];
const NUMBERS = [
  'intervalMinutes', 'wanderPages', 'dwellSeconds', 'maxPatrolsPerDay',
  'quietStartHour', 'quietEndHour', 'minAmount', 'dedupeMinutes',
  'minScorePage', 'minScorePopup',
];
const TEXTS = ['discordWebhookUrl', 'ntfyTopic'];

const $ = (id) => document.getElementById(id);

function parseTargets(text) {
  const targets = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)[\t ]+(https?:\/\/\S+)$/);
    const url = match ? match[2] : line;
    const name = match ? match[1].trim() : '';
    if (!/^https?:\/\//.test(url)) continue;
    targets.push({ name: name || url, url });
  }
  return targets;
}

function formatTargets(targets) {
  return (targets || []).map((t) => (t.name && t.name !== t.url ? `${t.name}\t${t.url}` : t.url)).join('\n');
}

function parseAmounts(text) {
  return String(text || '')
    .split(/[,、\s]+/)
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isFinite(v) && v > 0);
}

async function load() {
  const settings = await Settings.getSettings();
  for (const id of CHECKBOXES) $(id).checked = !!settings[id];
  for (const id of NUMBERS) $(id).value = settings[id];
  for (const id of TEXTS) $(id).value = settings[id] || '';
  $('targets').value = formatTargets(settings.targets);
  $('amountsWhitelist').value = (settings.amountsWhitelist || []).join(',');
  $('ignorePatterns').value = (settings.ignorePatterns || []).join('\n');
  $('discordField').style.display = settings.notifyDiscord ? '' : 'none';
  await renderStats();
}

async function save() {
  const patch = {};
  for (const id of CHECKBOXES) patch[id] = $(id).checked;
  for (const id of NUMBERS) patch[id] = Number($(id).value);
  for (const id of TEXTS) patch[id] = $(id).value.trim();
  patch.ntfyTopic = patch.ntfyTopic.trim();
  patch.targets = parseTargets($('targets').value);
  patch.amountsWhitelist = parseAmounts($('amountsWhitelist').value);
  patch.ignorePatterns = $('ignorePatterns').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!patch.targets.length) patch.targets = Settings.DEFAULTS.targets;

  await Settings.saveSettings(patch);
  $('discordField').style.display = patch.notifyDiscord ? '' : 'none';
  if (patch.notifyNtfy && !patch.ntfyTopic) {
    showStatus('testStatus', 'トピック名が空です。スマホ通知は送られません。', false);
  }
  await chrome.runtime.sendMessage({ type: 'rescheduleAlarm' }).catch(() => {});
}

function showStatus(id, message, ok) {
  const element = $(id);
  element.textContent = message;
  element.className = 'status show ' + (ok ? 'ok' : 'ng');
}

// --------------------------------------------------------------- 出現傾向

function table(title, rows) {
  if (!rows.length) return '';
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.bucket)}</td><td>${r.checks.toLocaleString()}</td>` +
        `<td>${r.hits.toLocaleString()}</td><td>${r.rate.toFixed(2)}%</td></tr>`
    )
    .join('');
  return `<table><caption style="text-align:left;color:var(--muted);font-size:12px;padding:6px 0">${title}</caption>
    <tr><th>区分</th><th>チェック</th><th>検出</th><th>出現率</th></tr>${body}</table>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function getHistory() {
  return (await chrome.storage.local.get('history')).history || [];
}

async function renderStats() {
  const history = await getHistory();
  const container = $('stats');
  if (!history.length) {
    container.innerHTML =
      '<p class="hint">まだ履歴がありません。しばらく動かしてから見てください。</p>';
    return;
  }
  const view = Stats.overview(history);
  const warning = view.detected === 0
    ? '<p class="hint">※ まだ検出ゼロです。抽選なので、数日〜数週間ぶん貯まってから見るのが現実的です。</p>'
    : !view.reliable
      ? `<p class="hint">※ 検出がまだ ${view.detected} 件です。この段階の差はほぼ偶然の範囲で、30件を超えたあたりから傾向として読めます。</p>`
      : '';

  const counts = Stats.amountCounts(history);
  const amountsTable = counts.length
    ? `<table><caption style="text-align:left;color:var(--muted);font-size:12px;padding:6px 0">金額別の検出回数</caption>
       <tr><th>金額</th><th>回数</th></tr>
       ${counts.map((c) => `<tr><td>${c.amount.toLocaleString()}円</td><td>${c.count}</td></tr>`).join('')}</table>`
    : '';

  container.innerHTML =
    `<p><b>${view.total.toLocaleString()}回</b>チェックして<b>${view.detected.toLocaleString()}回</b>検出
     （${view.rate.toFixed(2)}％／${view.days}日ぶん）</p>` +
    warning +
    table('ブラウザ別', Stats.summarize(history, 'browser')) +
    table('曜日別', Stats.summarize(history, 'weekday')) +
    table('時間帯別', Stats.summarize(history, 'hour')) +
    table('ページ別', Stats.summarize(history, 'target')) +
    amountsTable;
}

// ----------------------------------------------------------------- 配線

document.addEventListener('DOMContentLoaded', async () => {
  await load();

  for (const element of document.querySelectorAll('input, textarea')) {
    element.addEventListener('change', save);
  }

  $('copyTopic').addEventListener('click', async () => {
    const topic = $('ntfyTopic').value.trim();
    if (!topic) {
      showStatus('testStatus', 'トピック名が空です。', false);
      return;
    }
    await navigator.clipboard.writeText(topic);
    showStatus('testStatus', 'トピック名をコピーしました。ntfyアプリや2台目のブラウザで貼り付けてください。', true);
  });

  $('newTopic').addEventListener('click', async () => {
    if (!confirm('トピック名を作り直しますか？\nスマホのntfyアプリでも購読し直しが必要になります。')) return;
    const settings = await Settings.saveSettings({ ntfyTopic: Settings.randomTopic() });
    $('ntfyTopic').value = settings.ntfyTopic;
    showStatus('testStatus', '新しいトピック名を作りました。スマホ側も購読し直してください。', true);
  });

  $('test').addEventListener('click', async () => {
    showStatus('testStatus', '送信中…', true);
    const result = await chrome.runtime.sendMessage({ type: 'testNotify' }).catch((e) => ({
      ok: false,
      error: String(e),
    }));
    if (result && result.ok) {
      showStatus('testStatus', '送信しました。PCとスマホに届いたか確認してください。', true);
    } else {
      showStatus('testStatus', '送信に失敗しました: ' + ((result && result.error) || '不明'), false);
    }
  });

  $('exportCsv').addEventListener('click', async () => {
    const history = await getHistory();
    if (!history.length) return;
    const blob = new Blob(['﻿' + Stats.toCsv(history)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `yahoo-coupon-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  $('clearHistory').addEventListener('click', async () => {
    if (!confirm('履歴を全部消しますか？ 集計もリセットされます。')) return;
    await chrome.storage.local.set({ history: [] });
    await renderStats();
  });
});
