/*
 * popup.js — the small window that opens when you click the extension icon.
 *
 * It only SHOWS the saved state and SENDS your button presses to the
 * background. The work itself happens in background.js and content.js,
 * so closing this popup does not stop anything.
 */

const HOURLY_LIMIT = 15;
const HARD_MAX_DAILY_LIMIT = 80;
const MESSAGING_URL = 'https://www.linkedin.com/messaging/';

const $ = (id) => document.getElementById(id);
let lastState = null;
let activeTabOnLinkedIn = false;
let toastTimer = null;

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, message: String(e) }));
}

// Short message at the bottom of the popup (disappears after a few seconds).
function showMessage(textValue) {
  const t = $('toast');
  clearTimeout(toastTimer);
  if (!textValue) {
    t.classList.add('hidden');
    return;
  }
  t.textContent = textValue;
  t.classList.remove('hidden');
  toastTimer = setTimeout(() => t.classList.add('hidden'), 6000);
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function show(el, visible) {
  el.classList.toggle('hidden', !visible);
}

/* ---------------------------- Drawing the popup ------------------------- */

function render(state) {
  const s = state || {};
  const queue = s.queue || [];
  const settings = s.settings || {};
  const limit = Math.min(parseInt(settings.dailyLimit, 10) || 40, HARD_MAX_DAILY_LIMIT);
  const linksOnly = settings.mode === 'linksOnly';
  const running = s.status === 'running';
  const count = (st) => queue.filter((i) => i.status === st).length;

  /* Status badge */
  const pill = $('statusPill');
  let label = 'Idle';
  let kind = 'idle';
  if (running) {
    kind = 'running';
    label = s.phase === 'profiles' && s.inboxDone ? 'Visiting profiles' : 'Collecting inbox';
  } else if (s.status === 'paused') {
    kind = 'paused';
    label = 'Paused';
  } else if (s.status === 'stopped') {
    kind = 'stopped';
    label = 'Stopped';
  } else if (s.status === 'finished') {
    kind = 'finished';
    label = 'Finished';
  }
  pill.className = 'pill ' + kind;
  $('statusText').textContent = label;

  /* Banner: warnings, stop reasons, "finished" */
  const banner = $('warning');
  banner.className = 'banner';
  if (s.warning) {
    banner.textContent = '⚠ ' + s.warning;
  } else if (s.status === 'stopped' && s.reason) {
    banner.textContent = s.reason;
    banner.classList.add('notice');
  } else if (s.status === 'finished') {
    banner.textContent = '✓ ' + (s.reason || 'Done.') ;
    banner.classList.add('success');
  } else if (s.status === 'paused' && s.reason) {
    banner.textContent = s.reason;
    banner.classList.add('notice');
  } else {
    banner.classList.add('hidden');
  }

  /* "Now" box: what it is doing + countdown */
  const waiting = running && s.nextActionAt && s.nextActionAt > Date.now();
  show($('nowCard'), running);
  if (running) {
    let activity = s.activity || 'Working…';
    if (waiting && s.nextActionType === 'next') activity = 'Waiting a random pause before the next profile';
    $('activity').textContent = activity;
    // Icon: hourglass while waiting, coffee on a long break, gear while working.
    document.querySelector('.now-icon').textContent =
      waiting ? (s.nextActionType === 'next' ? '⏳' : '☕') : '⚙️';
    show($('countdown'), !!waiting);
    if (waiting) $('countdown').textContent = formatCountdown(s.nextActionAt - Date.now());
  }

  /* First-time help */
  show($('getStarted'), !running && (queue.length === 0 || !activeTabOnLinkedIn));
  show($('openMessagesBtn'), !activeTabOnLinkedIn);

  /* Mode cards */
  $('modeLinks').classList.toggle('active', linksOnly);
  $('modeFull').classList.toggle('active', !linksOnly);
  $('modeLinks').disabled = running;
  $('modeFull').disabled = running;
  show($('modeLock'), running);

  /* Main button */
  const main = $('mainBtn');
  if (running) {
    main.textContent = '⏸ Pause';
    main.className = 'main-btn pause';
  } else {
    const hasProgress = queue.length > 0 && s.status !== 'finished';
    main.textContent = hasProgress ? '▶ Continue' : '▶ Start';
    main.className = 'main-btn';
  }

  /* Numbers */
  const withLink = queue.filter((i) => i.profileUrl).length;
  const done = count('done');
  const left = count('pending');
  const failed = count('failed');
  $('statFound').textContent = queue.length;
  $('statLinks').textContent = withLink;
  $('statSkipped').textContent = count('skipped');
  $('statDone').textContent = done;
  $('statLeft').textContent = left;
  $('statFailed').textContent = failed;
  document.querySelectorAll('.full-only').forEach((el) => show(el, !linksOnly));

  const total = done + left + failed;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progressBar').style.width = pct + '%';
  $('progressPct').textContent = pct + '%';

  const today = s.daily && s.daily.date === todayStr() ? s.daily.count : 0;
  const hour = (s.hourly || []).filter((t) => Date.now() - t < 3600 * 1000).length;
  $('todayLine').textContent = today + ' / ' + limit + ' profiles today';
  $('todayLine').classList.toggle('over', today >= limit);
  $('hourLine').textContent = hour + ' / ' + HOURLY_LIMIT + ' this hour';

  /* Tools */
  $('retryBtn').disabled = failed === 0;
  $('exportLinksBtn').disabled = withLink === 0;
  $('exportBtn').disabled = queue.length === 0;
  if (document.activeElement !== $('limitInput')) $('limitInput').value = limit;
}

async function refresh() {
  const { state } = await chrome.storage.local.get('state');
  lastState = state || null;
  render(lastState);
}

async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // The URL is only visible to us on linkedin.com pages, which is all we need.
    activeTabOnLinkedIn = !!(tab && /^https:\/\/www\.linkedin\.com\//.test(tab.url || ''));
  } catch (e) {
    activeTabOnLinkedIn = false;
  }
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

// BOM = invisible first character that tells Excel the file is UTF-8,
// so names in any language show correctly.
const BOM = '\uFEFF';

// Makes one value safe for a CSV cell.
function csvCell(value) {
  let v = value == null ? '' : String(value);
  // Stop Excel from treating text like "=..." or "+1..." as a formula
  // (protects you if someone's profile text starts with these characters).
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g, '""') + '"';
}

function toCsv(rows) {
  return BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Full details: every conversation, all columns.
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
  return toCsv([CSV_COLUMNS, ...rows]);
}

// "Names + links only" mode file: contacts with a link, 4 columns.
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
  return { csv: toCsv([SIMPLE_COLUMNS, ...rows]), count: rows.length };
}

// Two columns only: Name, Profile URL.
function buildNameLinkCsv(queue) {
  const rows = queue
    .filter((i) => i.profileUrl)
    .map((i) => [(i.data && i.data.name) || i.name, (i.data && i.data.profileUrl) || i.profileUrl]);
  return { csv: toCsv([['Name', 'Profile URL'], ...rows]), count: rows.length };
}

function fileStamp() {
  return new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16);
}

async function downloadText(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  try {
    await chrome.downloads.download({ url, filename });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }
}

async function exportFull() {
  const { state } = await chrome.storage.local.get('state');
  const queue = (state && state.queue) || [];
  try {
    await downloadText(buildCsv(queue), 'linkedin-full-details-' + fileStamp() + '.csv', 'text/csv;charset=utf-8');
    const done = queue.filter((i) => i.status === 'done').length;
    showMessage(queue.length
      ? 'Downloaded ' + queue.length + ' rows (' + done + ' profiles with full details).'
      : 'Downloaded an empty file (only the column names). Nothing collected yet.');
  } catch (e) {
    showMessage('Download failed: ' + e.message);
  }
}

async function exportNameLinks() {
  const { state } = await chrome.storage.local.get('state');
  const result = buildNameLinkCsv((state && state.queue) || []);
  try {
    await downloadText(result.csv, 'linkedin-names-links-' + fileStamp() + '.csv', 'text/csv;charset=utf-8');
    showMessage(result.count
      ? 'Downloaded ' + result.count + ' contacts (Name + Profile URL).'
      : 'Downloaded an empty file. No profile links collected yet.');
  } catch (e) {
    showMessage('Download failed: ' + e.message);
  }
}

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
        out(g + '.' + k + ':');
        list.forEach((sel) => {
          let n = 0;
          try { n = deepAll(sel).length; } catch (e) { n = 'bad'; }
          out('    ' + n + ' × ' + sel);
        });
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

async function runDiagnose() {
  showMessage('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.linkedin\.com\//.test(tab.url || '')) {
    return showMessage('Open LinkedIn Messages, click one conversation, then press Diagnose.');
  }
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: diagnosePage });
    const report = (res && res.result) || 'No result.';
    await downloadText(report, 'linkedin-diagnose-' + Date.now() + '.txt', 'text/plain;charset=utf-8');
    showMessage('Report saved to your Downloads folder.');
  } catch (e) {
    showMessage('Diagnose failed: ' + e.message);
  }
}

/* ---------------------------- Buttons ----------------------------------- */

// The big button: Start / Continue when stopped, Pause when running.
$('mainBtn').addEventListener('click', async () => {
  if (lastState && lastState.status === 'running') {
    await send({ type: 'PAUSE' });
    showMessage('Paused. Your progress is saved.');
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showMessage('No active tab found.');
  const res = await send({ type: 'START', tabId: tab.id });
  showMessage(res && res.ok ? 'Started. You can close this window. It keeps working.' : (res && res.message) || 'Could not start.');
});

// Mode cards
['modeLinks', 'modeFull'].forEach((id) => {
  $(id).addEventListener('click', async () => {
    const value = $(id).dataset.mode;
    const res = await send({ type: 'SET_MODE', value });
    if (res && res.ok) {
      showMessage(value === 'linksOnly'
        ? 'Names + links: collects name and profile link only. No profiles are opened.'
        : 'Full profiles: also opens each profile slowly to read its details.');
    } else {
      showMessage((res && res.message) || 'Could not change the mode.');
    }
    refresh();
  });
});

$('openMessagesBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.tabs.update(tab.id, { url: MESSAGING_URL });
  else await chrome.tabs.create({ url: MESSAGING_URL });
  window.close();
});

$('exportLinksBtn').addEventListener('click', exportNameLinks);
$('exportBtn').addEventListener('click', exportFull);
$('diagnoseBtn').addEventListener('click', runDiagnose);

$('retryBtn').addEventListener('click', async () => {
  const res = await send({ type: 'RETRY_FAILED' });
  showMessage(res && res.ok ? res.count + ' failed profile(s) put back in the queue.' : 'Could not retry.');
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Are you sure? This deletes all saved progress and data.')) return;
  await send({ type: 'CLEAR_CACHE' });
  showMessage('All data cleared. (Today\'s count is kept so the daily limit still applies.)');
  refresh();
});

$('limitInput').addEventListener('change', async () => {
  const res = await send({ type: 'SET_DAILY_LIMIT', value: $('limitInput').value });
  if (res && res.ok) {
    $('limitInput').value = res.value;
    showMessage('Daily limit set to ' + res.value + ' profiles.');
  }
});

refresh();
checkActiveTab();
