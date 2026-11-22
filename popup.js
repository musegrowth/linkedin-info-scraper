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

  const linksOnly = settings.mode === 'linksOnly';

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
  if (linksOnly) {
    const withLink = queue.filter((i) => i.profileUrl).length;
    $('profilesLine').textContent = 'Contacts with profile link: ' + withLink + ' (' + count('skipped') + ' skipped)';
  } else {
    $('profilesLine').textContent =
      'Profiles: ' + count('done') + ' done, ' + count('pending') + ' left, ' + count('skipped') + ' skipped, ' + count('failed') + ' failed';
  }

  const today = s.daily && s.daily.date === todayStr() ? s.daily.count : 0;
  $('todayLine').textContent = today + ' of ' + limit + ' today';
  const hour = (s.hourly || []).filter((t) => Date.now() - t < 3600 * 1000).length;
  $('hourLine').textContent = 'This hour: ' + hour + ' of ' + HOURLY_LIMIT;

  // Buttons
  const running = s.status === 'running';
  $('startBtn').disabled = running;
  $('pauseBtn').disabled = !running;
  $('retryBtn').disabled = count('failed') === 0;

  // Mode selector (cannot be changed while running)
  if (document.activeElement !== $('modeSelect')) $('modeSelect').value = linksOnly ? 'linksOnly' : 'full';
  $('modeSelect').disabled = running;
  $('modeHint').textContent = linksOnly
    ? 'Stays on the Messages page. Saves only name + profile link. No profiles are opened.'
    : 'Collects the inbox, then opens each profile slowly to read its details.';
  // Daily/hourly limits are about profile visits, so they only matter in Full mode.
  $('limitRow').style.display = linksOnly ? 'none' : '';
  $('todayLine').style.display = linksOnly ? 'none' : '';
  $('hourLine').style.display = linksOnly ? 'none' : '';

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

// "Names + links only" export: just the contacts that have a profile link.
const SIMPLE_COLUMNS = ['Name', 'Profile URL', 'Conversation URL', 'Last Message Date'];

function buildSimpleCsv(queue) {
  const rows = queue
    .filter((i) => i.profileUrl)
    // If the profile was visited (Full mode), use the readable "main" URL found there.
    .map((i) => [
      (i.data && i.data.name) || i.name,
      (i.data && i.data.profileUrl) || i.profileUrl,
      i.conversationUrl,
      i.lastMessageDate
    ]);
  const lines = [SIMPLE_COLUMNS, ...rows].map((r) => r.map(csvCell).join(','));
  // \uFEFF = BOM so Excel reads UTF-8 names correctly.
  return { csv: '\uFEFF' + lines.join('\r\n') + '\r\n', count: rows.length };
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
  // \uFEFF = "BOM": tells Excel the file is UTF-8, so names in any language show correctly.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

async function exportCsv() {
  const { state } = await chrome.storage.local.get('state');
  const queue = (state && state.queue) || [];
  const linksOnly = !!(state && state.settings && state.settings.mode === 'linksOnly');
  const simple = linksOnly ? buildSimpleCsv(queue) : null;
  const csv = linksOnly ? simple.csv : buildCsv(queue);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16);
  try {
    const prefix = linksOnly ? 'linkedin-contacts-links-' : 'linkedin-profiles-';
    await chrome.downloads.download({ url, filename: prefix + stamp + '.csv' });
    if (linksOnly) {
      showMessage(simple.count
        ? 'Exported ' + simple.count + ' contacts (name + profile link).'
        : 'Exported an empty file (only the column names). Nothing collected yet.');
      return;
    }
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

$('modeSelect').addEventListener('change', async () => {
  const res = await send({ type: 'SET_MODE', value: $('modeSelect').value });
  if (res && res.ok) {
    showMessage(res.value === 'linksOnly' ? 'Mode: Names + links only.' : 'Mode: Full (visit each profile).');
  } else {
    showMessage((res && res.message) || 'Could not change the mode.');
  }
  refresh();
});

$('limitInput').addEventListener('change', async () => {
  const res = await send({ type: 'SET_DAILY_LIMIT', value: $('limitInput').value });
  if (res && res.ok) {
    $('limitInput').value = res.value;
    showMessage('Daily limit set to ' + res.value + '.');
  }
});

/* ---------------------------- Diagnose ---------------------------------- */
/*
 * Runs inside the current LinkedIn tab and describes how the page is built:
 * which selectors from selectors.js find something, and every profile link
 * on the page with the "class names" around it. It reads only the page
 * structure plus names/links shown in the header — not your messages.
 * The result is saved as a .txt file you can send to whoever fixes selectors.
 */
function diagnosePage() {
  const S = typeof LIC_SELECTORS !== 'undefined' ? LIC_SELECTORS : null;
  const lines = [];
  const out = (s) => lines.push(s);
  const short = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n || 80);
  const cls = (el) => (el && el.className && typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : '');
  const chain = (el) => {
    const parts = [];
    let e = el;
    for (let i = 0; i < 6 && e && e.tagName; i++) {
      parts.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls(e) ? '.' + cls(e).slice(0, 80) : ''));
      e = e.parentElement || (e.getRootNode && e.getRootNode().host) || null;
    }
    return parts.join('  <  ');
  };
  const deepAll = (sel, root) => {
    root = root || document;
    let res = [];
    try { res = Array.from(root.querySelectorAll(sel)); } catch (e) { return res; }
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) res = res.concat(deepAll(sel, el.shadowRoot));
    });
    return res;
  };

  out('LinkedIn page diagnosis — ' + new Date().toISOString());
  out('Page path: ' + location.pathname);
  out('Selectors file loaded: ' + (S ? 'yes' : 'NO (reload the extension and this tab)'));
  let shadowCount = 0;
  document.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) shadowCount++; });
  out('Shadow roots on page: ' + shadowCount);
  out('');

  if (S) {
    out('=== Selector check (count found) ===');
    const groups = { inbox: S.inbox, thread: S.thread, profile: S.profile };
    Object.keys(groups).forEach((g) => {
      Object.keys(groups[g]).forEach((k) => {
        const list = groups[g][k];
        if (!Array.isArray(list)) return;
        const counts = list.map((sel) => {
          let n = 0;
          try { n = deepAll(sel).length; } catch (e) { n = 'bad'; }
          return n + ' × ' + sel;
        });
        out(g + '.' + k + ':');
        counts.forEach((c) => out('    ' + c));
      });
    });
    out('');
  }

  out('=== Every profile link (/in/) on the page ===');
  const links = deepAll('a[href*="/in/"]');
  out('Total: ' + links.length);
  links.slice(0, 40).forEach((a, i) => {
    const href = a.getAttribute('href') || '';
    const kind = /\/in\/ACo[A-Za-z0-9_-]{10,}/.test(href) ? 'internal-id link' : 'readable link';
    const label = short([a.innerText, a.getAttribute('aria-label'), a.getAttribute('title'),
      Array.from(a.querySelectorAll('img')).map((im) => im.alt).join(' ')].join(' | '), 100);
    out('#' + (i + 1) + ' [' + kind + '] ' + href.split('?')[0]);
    out('    label: ' + label);
    out('    where: ' + chain(a));
  });
  out('');

  out('=== Conversation header candidates ===');
  const headerSel = ['header', '[class*="title-bar"]', '[class*="topcard"]', '[class*="profile-card"]', '[class*="entity-lockup"]', '[class*="thread"] h2'];
  headerSel.forEach((sel) => {
    deepAll(sel).slice(0, 4).forEach((el) => {
      if (el.closest('#global-nav, .global-nav')) return;
      out('[' + sel + '] ' + chain(el));
      out('    text: ' + short(el.innerText, 120));
      out('    html: ' + short(el.outerHTML, 1200));
    });
  });

  return lines.join('\n');
}

$('diagnoseBtn').addEventListener('click', async () => {
  showMessage('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.linkedin\.com\//.test(tab.url || '')) {
    return showMessage('Open LinkedIn Messages, click one conversation, then press Diagnose.');
  }
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: diagnosePage });
    const report = (res && res.result) || 'No result.';
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
    await chrome.downloads.download({ url, filename: 'linkedin-diagnose-' + Date.now() + '.txt' });
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    showMessage('Report saved to your Downloads folder.');
  } catch (e) {
    showMessage('Diagnose failed: ' + e.message);
  }
});

refresh();
