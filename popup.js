/*
 * popup.js — the small window that opens when you click the extension icon.
 *
 * It only SHOWS the saved state and SENDS your button presses to the
 * background. The work itself happens in background.js and content.js,
 * so closing this popup does not stop anything.
 */

const HOURLY_LIMIT = 15;
const HARD_MAX_DAILY_LIMIT = 80;

const $ = (id) => document.getElementById(id);
let lastState = null;

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, message: String(e) }));
}

function showMessage(textValue) {
  $('message').textContent = textValue || '';
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

/* ---------------------------- Drawing the popup ------------------------- */

function render(state) {
  const s = state || {};
  const queue = s.queue || [];
  const settings = s.settings || {};
  const limit = Math.min(parseInt(settings.dailyLimit, 10) || 40, HARD_MAX_DAILY_LIMIT);

  // Status line
  let status = 'Idle';
  if (s.status === 'running') status = s.phase === 'profiles' && s.inboxDone ? 'Visiting profiles' : 'Collecting inbox';
  else if (s.status === 'paused') status = 'Paused';
  else if (s.status === 'stopped') status = 'Stopped' + (s.reason ? ': ' + s.reason : '');
  else if (s.status === 'finished') status = 'Finished';
  $('status').textContent = status;

  // Activity line (with a live countdown while waiting)
  let activity = '';
  if (s.status === 'running') {
    activity = s.activity || '';
    if (s.nextActionAt && s.nextActionAt > Date.now()) {
      const left = formatCountdown(s.nextActionAt - Date.now());
      if (s.nextActionType === 'next') activity = 'Next profile in ' + left;
      else activity = (s.activity || 'Waiting') + ' (' + left + ')';
    }
  } else if (s.status === 'paused' || s.status === 'finished') {
    activity = s.reason || '';
  }
  $('activity').textContent = activity;

  // Warning box
  const warn = $('warning');
  if (s.warning) {
    warn.textContent = '⚠ ' + s.warning;
    warn.classList.remove('hidden', 'notice');
  } else if (s.status === 'stopped' && s.reason) {
    warn.textContent = s.reason;
    warn.classList.remove('hidden');
    warn.classList.add('notice');
  } else {
    warn.classList.add('hidden');
  }

  // Numbers
  const count = (st) => queue.filter((i) => i.status === st).length;
  $('inboxLine').textContent =
    'Inbox: ' + queue.length + ' found' + (queue.length ? (s.inboxDone ? ' (complete)' : ' (still collecting)') : '');
  $('profilesLine').textContent =
    'Profiles: ' + count('done') + ' done, ' + count('pending') + ' left, ' + count('skipped') + ' skipped, ' + count('failed') + ' failed';

  const today = s.daily && s.daily.date === todayStr() ? s.daily.count : 0;
  $('todayLine').textContent = today + ' of ' + limit + ' today';
  const hour = (s.hourly || []).filter((t) => Date.now() - t < 3600 * 1000).length;
  $('hourLine').textContent = 'This hour: ' + hour + ' of ' + HOURLY_LIMIT;

  // Buttons
  const running = s.status === 'running';
  $('startBtn').disabled = running;
  $('pauseBtn').disabled = !running;
  $('retryBtn').disabled = count('failed') === 0;

  // Daily limit box (do not overwrite while you are typing in it)
  if (document.activeElement !== $('limitInput')) $('limitInput').value = limit;
}

async function refresh() {
  const { state } = await chrome.storage.local.get('state');
  lastState = state || null;
  render(lastState);
}

// Redraw whenever the saved state changes, and every second for the countdown.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) {
    lastState = changes.state.newValue || null;
    render(lastState);
  }
});
setInterval(() => render(lastState), 1000);

/* ---------------------------- CSV export -------------------------------- */

const CSV_COLUMNS = [
  'Name', 'Headline', 'Company', 'Job Title', 'Location', 'Connection Degree',
  'Email', 'Phone', 'Website', 'Profile URL', 'Conversation URL',
  'Last Message Date', 'Scraped Date', 'Status'
];

// Makes one value safe for a CSV cell.
function csvCell(value) {
  let v = value == null ? '' : String(value);
  // Stop Excel from treating text like "=..." or "+1..." as a formula
  // (protects you if someone's profile text starts with these characters).
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g, '""') + '"';
}

function buildCsv(queue) {
  const rows = queue.map((i) => {
    const d = i.data || {};
    return [
      d.name || i.name,
      d.headline,
      d.company,
      d.jobTitle,
      d.location,
      d.degree,
      d.email,
      d.phone,
      d.website,
      d.profileUrl || i.profileUrl,
      i.conversationUrl,
      i.lastMessageDate,
      d.scrapedAt || '',
      i.status + (i.reason && i.status !== 'done' ? ' (' + i.reason + ')' : '')
    ];
  });
  const lines = [CSV_COLUMNS, ...rows].map((r) => r.map(csvCell).join(','));
  // ﻿ = "BOM": tells Excel the file is UTF-8, so names in any language show correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

async function exportCsv() {
  const { state } = await chrome.storage.local.get('state');
  const queue = (state && state.queue) || [];
  const csv = buildCsv(queue);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16);
  try {
    await chrome.downloads.download({ url, filename: 'linkedin-profiles-' + stamp + '.csv' });
    const done = queue.filter((i) => i.status === 'done').length;
    showMessage(queue.length
      ? 'Exported ' + queue.length + ' rows (' + done + ' profiles scraped).'
      : 'Exported an empty file (only the column names). Nothing collected yet.');
  } catch (e) {
    showMessage('Export failed: ' + e.message);
  }
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

/* ---------------------------- Buttons ----------------------------------- */

$('startBtn').addEventListener('click', async () => {
  showMessage('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showMessage('No active tab found.');
  const res = await send({ type: 'START', tabId: tab.id });
  showMessage(res && res.ok ? 'Started. You can close this popup.' : (res && res.message) || 'Could not start.');
});

$('pauseBtn').addEventListener('click', async () => {
  await send({ type: 'PAUSE' });
  showMessage('Paused. Progress is saved.');
});

$('exportBtn').addEventListener('click', exportCsv);

$('retryBtn').addEventListener('click', async () => {
  const res = await send({ type: 'RETRY_FAILED' });
  showMessage(res && res.ok ? res.count + ' failed item(s) moved back to the queue.' : 'Could not retry.');
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Are you sure? This deletes all saved progress and data.')) return;
  await send({ type: 'CLEAR_CACHE' });
  showMessage('Cache cleared. (Today\'s count is kept so the daily limit still applies.)');
  refresh();
});

$('limitInput').addEventListener('change', async () => {
  const res = await send({ type: 'SET_DAILY_LIMIT', value: $('limitInput').value });
  if (res && res.ok) {
    $('limitInput').value = res.value;
    showMessage('Daily limit set to ' + res.value + '.');
  }
});

refresh();
