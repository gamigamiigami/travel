'use strict';

const CHECKBOXES = [
  'enabled', 'patrolEnabled', 'notifyDesktop', 'notifyNtfy', 'notifyDiscord', 'autoClaim', 'searchEnabled', 'preferExpensive', 'expandBadge', 'requireCountdown',
];
const NUMBERS = [
  'intervalMinutes', 'wanderPages', 'dwellSeconds', 'maxPatrolsPerDay',
  'quietStartHour', 'quietEndHour', 'minAmount', 'dedupeMinutes',
  'minScorePage', 'minScorePopup', 'minHotelPrice', 'maxTimeLimitMin',
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
  $('searchKeywords').value = (settings.searchKeywords || []).join('、');
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
  patch.searchKeywords = $('searchKeywords').value
    .split(/[,、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!patch.searchKeywords.length) patch.searchKeywords = Settings.DEFAULTS.searchKeywords;
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

/**
 * ページの中身をそのまま吸い出す（全フレーム）。
 *
 * この関数は対象ページ側で実行されるため、拡張側の変数は一切使えない。
 * 検出ロジックを通さず「生の材料」を集めるのが目的。
 */
function dumpFrame() {
  const SELECTORS = [
    "[role='dialog']", "[aria-modal='true']", 'dialog',
    "[class*='oupon']", "[id*='oupon']", "[data-testid*='oupon']",
    "[class*='odal']", "[class*='opup']", "[class*='alloon']", "[class*='oast']",
  ];

  const roots = [];
  const walk = (root, depth) => {
    if (depth > 4 || roots.length > 30) return;
    let elements;
    try {
      elements = root.querySelectorAll('*');
    } catch (e) {
      return;
    }
    for (const element of elements) {
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        walk(element.shadowRoot, depth + 1);
      }
    }
  };
  try {
    walk(document, 0);
  } catch (e) {
    /* shadow root が辿れなくても本文は出す */
  }

  const blocks = [];
  const seen = new Set();
  for (const root of [document].concat(roots)) {
    for (const selector of SELECTORS) {
      let elements;
      try {
        elements = root.querySelectorAll(selector);
      } catch (e) {
        continue;
      }
      for (const element of Array.from(elements).slice(0, 8)) {
        if (seen.has(element)) continue;
        seen.add(element);
        const text = (element.innerText || '').slice(0, 2000);
        if (!text.trim()) continue;
        blocks.push({
          selector,
          visible: element.getClientRects().length > 0,
          className: String(element.className || '').slice(0, 150),
          text,
        });
      }
    }
  }

  const labels = [];
  try {
    const labelled = document.querySelectorAll('img[alt], [aria-label], [title]');
    for (const node of Array.from(labelled).slice(0, 150)) {
      const label =
        node.getAttribute('alt') || node.getAttribute('aria-label') || node.getAttribute('title');
      if (label && /クーポン|OFF|オフ|円|coupon/i.test(label)) labels.push(label.slice(0, 200));
    }
  } catch (e) {
    /* 属性が取れなくても続行 */
  }

  return {
    url: location.href,
    title: document.title,
    isTopFrame: window.top === window,
    shadowRootCount: roots.length,
    blocks,
    labels,
    bodyText: ((document.body && document.body.innerText) || '').slice(0, 15000),
  };
}

function formatDump(frames) {
  const lines = [
    '===== Yahoo!トラベル クーポンウォッチャー 診断データ =====',
    '保存日時: ' + new Date().toLocaleString('ja-JP'),
    'フレーム数: ' + frames.length,
    '',
  ];
  frames.forEach((frame, index) => {
    if (!frame) return;
    lines.push('#'.repeat(60));
    lines.push(`[フレーム ${index + 1}] ${frame.isTopFrame ? '(メイン)' : '(iframe)'}`);
    lines.push('URL   : ' + frame.url);
    lines.push('タイトル: ' + frame.title);
    lines.push('shadow root の数: ' + frame.shadowRootCount);
    lines.push('');
    lines.push('--- ポップアップらしき要素 (' + frame.blocks.length + '件) ---');
    if (!frame.blocks.length) lines.push('(なし)');
    frame.blocks.forEach((block, i) => {
      lines.push(`[${i + 1}] ${block.selector}  表示中=${block.visible}`);
      lines.push(`    class: ${block.className}`);
      lines.push('    ' + block.text.split('\n').join('\n    '));
      lines.push('');
    });
    lines.push('--- クーポンらしき alt / aria-label (' + frame.labels.length + '件) ---');
    lines.push(frame.labels.length ? frame.labels.join('\n') : '(なし)');
    lines.push('');
    lines.push('--- ページ全体のテキスト ---');
    lines.push(frame.bodyText);
    lines.push('');
  });
  return lines.join('\n');
}

async function saveDiagnostics() {
  const tabs = await chrome.tabs.query({ url: ['*://*.travel.yahoo.co.jp/*'] });
  if (!tabs.length) {
    showStatus('diagStatus', 'Yahoo!トラベルのタブが見つかりません。開いた状態で押してください。', false);
    return;
  }
  const tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: dumpFrame,
    });
  } catch (e) {
    showStatus('diagStatus', '読み取れませんでした: ' + ((e && e.message) || e), false);
    return;
  }

  const frames = (results || []).map((r) => r && r.result).filter(Boolean);
  if (!frames.length) {
    showStatus('diagStatus', '中身を取得できませんでした。', false);
    return;
  }

  const blob = new Blob(['\ufeff' + formatDump(frames)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `coupon-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  const total = frames.reduce((sum, f) => sum + f.blocks.length, 0);
  showStatus(
    'diagStatus',
    `保存しました（${frames.length}フレーム／ポップアップ候補${total}件）。中身を確認のうえ送ってください。`,
    true
  );
}

function clockOf(timestamp) {
  const date = new Date(timestamp);
  return (
    String(date.getHours()).padStart(2, '0') + ':' +
    String(date.getMinutes()).padStart(2, '0') + ':' +
    String(date.getSeconds()).padStart(2, '0')
  );
}

async function renderActivity() {
  const activity = (await chrome.storage.local.get('activity')).activity || [];
  const container = $('activity');
  if (!activity.length) {
    container.textContent = 'まだ記録がありません。下のボタンで1回動かしてみてください。';
    return;
  }
  container.innerHTML = activity
    .slice()
    .reverse()
    .map(
      (entry) =>
        `<div><time>${clockOf(entry.t)}</time>` +
        `<span class="${entry.level === 'hit' ? 'hit' : entry.level === 'warn' ? 'warn' : ''}">` +
        `${escapeHtml(entry.message)}</span></div>`
    )
    .join('');
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

  await renderActivity();
  setInterval(renderActivity, 5000);

  $('watchPatrol').addEventListener('click', async () => {
    $('watchPatrol').disabled = true;
    $('watchPatrol').textContent = '巡回中…（タブの動きを見てください）';
    await chrome.runtime.sendMessage({ type: 'patrolNow', visible: true }).catch(() => {});
    $('watchPatrol').disabled = false;
    $('watchPatrol').textContent = '巡回を目で見る（タブを表示して1回実行）';
    await renderActivity();
  });

  $('diagnose').addEventListener('click', async () => {
    showStatus('diagStatus', '読み取り中…', true);
    await saveDiagnostics();
  });

  $('clearActivity').addEventListener('click', async () => {
    await chrome.storage.local.set({ activity: [] });
    await renderActivity();
  });

  $('clearHistory').addEventListener('click', async () => {
    if (!confirm('履歴を全部消しますか？ 集計もリセットされます。')) return;
    await chrome.storage.local.set({ history: [] });
    await renderStats();
  });
});
