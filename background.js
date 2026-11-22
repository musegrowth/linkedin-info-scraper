/*
 * background.js — the "brain" of the extension (a Manifest V3 service worker).
 *
 * What it does:
 *  - Holds the saved state (queue, scraped data, counters) in chrome.storage.local.
 *  - Decides the next step: collect inbox → visit profiles one by one.
 *  - Runs all the long waits (25–90 s between profiles, 5–15 min breaks)
 *    with chrome.alarms, so they survive Chrome putting this script to sleep.
 *  - Enforces the safety limits (daily, hourly, 3 failures in a row,
 *    security checks).
 *
 * Chrome may stop this script at any time when it is idle. That is fine:
 * nothing important is kept only in memory. Every step loads the state from
 * storage, changes it, and saves it again straight away.
 */

/* ---------------------------- Settings ---------------------------------- */

const DEFAULT_DAILY_LIMIT = 40;
const HARD_MAX_DAILY_LIMIT = 80;
const HOURLY_LIMIT = 15;
const MESSAGING_URL = 'https://www.linkedin.com/messaging/';

// All delays are random values inside these ranges.
const WAIT_BETWEEN_PROFILES_SEC = [25, 90];
const LONG_BREAK_MIN = [5, 15];
const LONG_BREAK_EVERY = [10, 15]; // profiles
const HOURLY_EXTRA_WAIT_SEC = [10, 60]; // added after the hourly window frees up

// If the page does not answer within this time, something went wrong.
// (Kept generous because Chrome slows down timers in background tabs.)
const WATCHDOG_PROFILE_MIN = 4;
const WATCHDOG_INBOX_MIN = 5;

const MAX_FAILURES_IN_A_ROW = 3;

const DAILY_LIMIT_MESSAGE = 'Daily limit reached. Resume tomorrow.';

/* ---------------------------- Small helpers ----------------------------- */

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Random number of milliseconds between minSec and maxSec seconds.
function randMs(minSec, maxSec) {
  return Math.round((minSec + Math.random() * (maxSec - minSec)) * 1000);
}

// Today's date in the computer's own time zone, e.g. "2026-11-22".
function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Turns any LinkedIn profile link into one clean form:
// https://www.linkedin.com/in/<name>/   (used to remove duplicates)
function normalizeProfileUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url, 'https://www.linkedin.com');
    const m = u.pathname.match(/^\/in\/([^/?#]+)/);
    return m ? 'https://www.linkedin.com/in/' + m[1] + '/' : '';
  } catch (e) {
    return '';
  }
}

function isLinkedInUrl(url) {
  return /^https:\/\/www\.linkedin\.com\//.test(url || '');
}

function isMessagingUrl(url) {
  try { return new URL(url).pathname.startsWith('/messaging'); } catch (e) { return false; }
}

function isProfileUrl(url) {
  try { return /^\/in\/[^/]+/.test(new URL(url).pathname); } catch (e) { return false; }
}

// Login / checkpoint / verification pages (same list idea as selectors.js).
function isSecurityUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('linkedin.com')) return false;
    return /^\/(checkpoint|login|uas\/|authwall|signup|challenge|security)/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

/* ---------------------------- Saved state ------------------------------- */

function defaultState() {
  return {
    // idle | running | paused | stopped | finished
    status: 'idle',
    reason: '',        // why it paused/stopped
    warning: '',       // big red warning for the popup (security, failures)
    activity: '',      // short "what am I doing now" line
    phase: 'inbox',    // inbox | profiles
    inboxDone: false,

    workTabId: null,   // the one tab the tool works in
    runId: 0,          // changes on every Start/Pause so old messages are ignored

    queue: [],         // one item per conversation (see addConversation)
    seenKeys: [],      // inbox rows already handled (so resume does not re-open them)

    currentKey: null,  // queue item being visited right now
    nextActionAt: 0,   // when the next step is planned (for the popup countdown)
    nextActionType: '',// next | break | hourly

    consecutiveFailures: 0,
    profilesSinceBreak: 0,
    breakEvery: randInt(LONG_BREAK_EVERY[0], LONG_BREAK_EVERY[1]),

    // mode: 'full'      → collect inbox, then visit every profile
    //       'linksOnly' → only collect names + profile links from the inbox
    settings: { dailyLimit: DEFAULT_DAILY_LIMIT, mode: 'full' },
    daily: { date: todayStr(), count: 0 },
    hourly: []         // timestamps of profile visits in the last hour
  };
}

async function loadState() {
  const { state } = await chrome.storage.local.get('state');
  const s = Object.assign(defaultState(), state || {});
  s.settings = Object.assign({ dailyLimit: DEFAULT_DAILY_LIMIT, mode: 'full' }, s.settings || {});
  // New day → reset the daily counter.
  if (!s.daily || s.daily.date !== todayStr()) s.daily = { date: todayStr(), count: 0 };
  // Keep only visits from the last 60 minutes.
  s.hourly = (s.hourly || []).filter((t) => Date.now() - t < 3600 * 1000);
  return s;
}

async function saveState(s) {
  await chrome.storage.local.set({ state: s });
}

function isLinksOnly(s) {
  return s.settings && s.settings.mode === 'linksOnly';
}

function dailyLimit(s) {
  const n = parseInt(s.settings.dailyLimit, 10);
  if (!n || n < 1) return DEFAULT_DAILY_LIMIT;
  return Math.min(n, HARD_MAX_DAILY_LIMIT);
}

// How long until another profile may be visited without breaking the
// hourly limit (0 = can go now).
function hourlyWaitMs(s) {
  const recent = s.hourly.filter((t) => Date.now() - t < 3600 * 1000).sort((a, b) => a - b);
  if (recent.length < HOURLY_LIMIT) return 0;
  const oldestThatMatters = recent[recent.length - HOURLY_LIMIT];
  return Math.max(0, oldestThatMatters + 3600 * 1000 - Date.now());
}

function recordVisit(s) {
  s.daily.count += 1;
  s.hourly.push(Date.now());
  s.profilesSinceBreak += 1;
}

function findItem(s, key) {
  return s.queue.find((i) => i.key === key) || null;
}

function hasPending(s) {
  return s.queue.some((i) => i.status === 'pending');
}

/* ------------------- One-thing-at-a-time lock ---------------------------
 * Messages and alarms can arrive at the same moment. This makes them run
 * one after another so two of them never overwrite each other's changes.
 */
let lockChain = Promise.resolve();
function locked(fn) {
  const run = lockChain.then(fn);
  lockChain = run.catch((e) => console.error('[Collector]', e));
  return run;
}

/* ---------------------------- Stopping ---------------------------------- */

// Stops the current run (pause, stop, finish) and saves first.
async function haltRun(s, status, reason, warning) {
  s.status = status;
  s.reason = reason || '';
  s.warning = warning || '';
  s.activity = '';
  s.currentKey = null; // the item being visited stays "pending" and is retried next time
  s.nextActionAt = 0;
  s.nextActionType = '';
  s.runId += 1;        // anything still running for the old run is ignored
  await saveState(s);
  await chrome.alarms.clearAll();
  if (s.workTabId != null) {
    chrome.tabs.sendMessage(s.workTabId, { type: 'ABORT' }).catch(() => {});
  }
}

function securityStop(s, detail) {
  return haltRun(
    s,
    'stopped',
    'Security check detected',
    'LinkedIn is showing a security check or login page' +
      (detail ? ' (' + detail + ')' : '') +
      '. The tool stopped and saved your progress. Handle it yourself in the tab. ' +
      'It is safest to wait until tomorrow before pressing Start again.'
  );
}

function finish(s) {
  return haltRun(s, 'finished', 'All profiles in the queue have been visited.');
}

/* ---------------------------- Moving forward ---------------------------- */

// Opens a URL in the work tab. The content script on that page will then
// ask us what to do (PAGE_READY).
async function navigate(s, url) {
  try {
    await chrome.tabs.update(s.workTabId, { url });
  } catch (e) {
    await haltRun(s, 'paused', 'The LinkedIn tab could not be found (was it closed?). Press Start in a LinkedIn tab.');
  }
}

// Tells the already-open page to start working, without reloading it.
// If the page has no live copy of content.js (e.g. the extension was just
// reloaded), a fresh copy is added to the page — still no reload.
async function kickPageInPlace(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'KICK' });
    return true;
  } catch (e) {
    // No listener in the page → inject the scripts. On load, content.js
    // asks for its job by itself.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['selectors.js', 'content.js'] });
    return true;
  } catch (e) {
    console.warn('[Collector] Could not add the script to the page:', e);
    return false;
  }
}

// Does the next step of the job.
async function advance(s) {
  s.nextActionAt = 0;
  s.nextActionType = '';
  if (s.status !== 'running') return saveState(s);

  // Phase 1: the inbox list is not finished yet.
  if (!s.inboxDone) {
    s.phase = 'inbox';
    s.activity = 'Starting on the inbox…';
    await saveState(s);
    await chrome.alarms.create('watchdog', { delayInMinutes: WATCHDOG_INBOX_MIN });

    // Already on the Messages page? Work right there — do NOT reload it.
    let tabUrl = '';
    try { tabUrl = (await chrome.tabs.get(s.workTabId)).url || ''; } catch (e) { tabUrl = ''; }
    if (isMessagingUrl(tabUrl)) {
      if (await kickPageInPlace(s.workTabId)) return;
    }
    // Otherwise open the inbox.
    return navigate(s, MESSAGING_URL);
  }

  // Phase 2: visit the next pending profile.
  s.phase = 'profiles';
  if (isLinksOnly(s)) return haltRun(s, 'finished', 'Names + links only mode: no profiles are visited. Press Export CSV.');
  if (s.daily.count >= dailyLimit(s)) return haltRun(s, 'stopped', DAILY_LIMIT_MESSAGE);

  const hw = hourlyWaitMs(s);
  if (hw > 0) return scheduleAt(s, Date.now() + hw + randMs(...HOURLY_EXTRA_WAIT_SEC), 'hourly');

  const item = s.queue.find((i) => i.status === 'pending');
  if (!item) return finish(s);

  s.currentKey = item.key;
  s.activity = 'Opening profile: ' + (item.name || item.profileUrl);
  await saveState(s);
  await chrome.alarms.create('watchdog', { delayInMinutes: WATCHDOG_PROFILE_MIN });
  return navigate(s, item.profileUrl);
}

// Plans the next step for a moment in the future.
async function scheduleAt(s, when, type) {
  s.nextActionAt = when;
  s.nextActionType = type;
  if (type === 'break') s.activity = 'Long break. Back at ' + clockTime(when);
  else if (type === 'hourly') s.activity = 'Hourly limit (' + HOURLY_LIMIT + '/hour) reached. Back at ' + clockTime(when);
  else s.activity = 'Waiting before the next profile';
  await saveState(s);
  await chrome.alarms.clear('watchdog');
  await chrome.alarms.create('nextStep', { when });
}

// Called after every profile (success or failure): checks the limits and
// plans a random wait before the next one.
async function scheduleNext(s) {
  s.currentKey = null;
  if (s.status !== 'running') return saveState(s);
  if (!hasPending(s)) return finish(s);
  if (s.daily.count >= dailyLimit(s)) return haltRun(s, 'stopped', DAILY_LIMIT_MESSAGE);

  let delay;
  let type;
  if (s.profilesSinceBreak >= s.breakEvery) {
    delay = randMs(LONG_BREAK_MIN[0] * 60, LONG_BREAK_MIN[1] * 60);
    type = 'break';
    s.profilesSinceBreak = 0;
    s.breakEvery = randInt(LONG_BREAK_EVERY[0], LONG_BREAK_EVERY[1]);
  } else {
    delay = randMs(WAIT_BETWEEN_PROFILES_SEC[0], WAIT_BETWEEN_PROFILES_SEC[1]);
    type = 'next';
  }

  const hw = hourlyWaitMs(s);
  if (hw > delay) {
    delay = hw + randMs(...HOURLY_EXTRA_WAIT_SEC);
    type = 'hourly';
  }
  return scheduleAt(s, Date.now() + delay, type);
}

// After a profile finished (ok = true) or failed (ok = false).
async function afterProfile(s, ok) {
  if (ok) {
    s.consecutiveFailures = 0;
  } else {
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= MAX_FAILURES_IN_A_ROW) {
      return haltRun(
        s,
        'stopped',
        MAX_FAILURES_IN_A_ROW + ' profiles in a row failed to load',
        MAX_FAILURES_IN_A_ROW + ' profiles in a row failed to load. LinkedIn may be slow, or the layout changed, ' +
          'or your account is being limited. Look at the tab. When things look normal, press "Retry failed" and then Start.'
      );
    }
  }
  return scheduleNext(s);
}

/* ---------------------------- Popup commands ---------------------------- */

async function startRun(s, tabId) {
  if (s.status === 'running') {
    return { ok: false, message: 'Already running. Press Pause first if you want to restart.' };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return { ok: false, message: 'Could not find the current tab.' };
  }
  if (!isLinkedInUrl(tab.url)) {
    return { ok: false, message: 'Open https://www.linkedin.com/messaging/ in this tab first, then press Start.' };
  }

  if (s.inboxDone && isLinksOnly(s)) {
    return {
      ok: false,
      message: 'Names + links are already collected. Press Export CSV. ' +
        '(To also visit profiles, switch Mode to "Full", or Clear cache to collect the inbox again.)'
    };
  }

  if (s.inboxDone) {
    if (!hasPending(s)) {
      return { ok: false, message: 'No profiles left to visit. Use "Retry failed" or "Clear cache".' };
    }
    if (s.daily.count >= dailyLimit(s)) {
      s.status = 'stopped';
      s.reason = DAILY_LIMIT_MESSAGE;
      await saveState(s);
      return { ok: false, message: DAILY_LIMIT_MESSAGE };
    }
  }

  await chrome.alarms.clearAll();
  s.status = 'running';
  s.reason = '';
  s.warning = '';
  s.workTabId = tabId;
  s.runId += 1;
  s.consecutiveFailures = 0;
  await advance(s);
  return { ok: true };
}

async function clearCache(s) {
  if (s.status === 'running') await haltRun(s, 'idle', '');
  // Keep the daily-limit setting and today's/this hour's counters, so that
  // clearing the cache can never be used to go over the safety limits.
  const fresh = defaultState();
  fresh.settings = s.settings;
  fresh.daily = s.daily;
  fresh.hourly = s.hourly;
  fresh.runId = s.runId + 1;
  await chrome.alarms.clearAll();
  await chrome.storage.local.clear();
  await saveState(fresh);
  return { ok: true };
}

/* ---------------------------- Page messages ----------------------------- */

// True when a message comes from the current run in the work tab.
function isFromActiveRun(s, msg, sender) {
  return (
    s.status === 'running' &&
    sender.tab &&
    sender.tab.id === s.workTabId &&
    msg.runId === s.runId
  );
}

// Every LinkedIn page asks "what should I do?" when it finishes loading.
async function onPageReady(s, msg, sender) {
  if (s.status !== 'running' || !sender.tab || sender.tab.id !== s.workTabId) return { task: null };

  const url = msg.url || '';
  if (isSecurityUrl(url) || msg.security) {
    await securityStop(s, msg.security || 'page: ' + new URL(url).pathname);
    return { task: null };
  }

  if (s.phase === 'inbox' && !s.inboxDone) {
    if (!isMessagingUrl(url)) return { task: null }; // the watchdog will catch a stuck run
    s.activity = 'Collecting inbox…';
    await saveState(s);
    await chrome.alarms.create('watchdog', { delayInMinutes: WATCHDOG_INBOX_MIN });
    return { task: 'INBOX', runId: s.runId, knownKeys: knownInboxKeys(s) };
  }

  if (s.phase === 'profiles' && s.currentKey) {
    const item = findItem(s, s.currentKey);
    if (!item) return { task: null };
    if (isProfileUrl(url)) {
      s.activity = 'Reading profile: ' + (item.name || item.profileUrl);
      await saveState(s);
      return { task: 'PROFILE', runId: s.runId, key: item.key, name: item.name };
    }
    // LinkedIn sent us somewhere else instead of the profile.
    await chrome.alarms.clear('watchdog');
    recordVisit(s);
    item.status = 'failed';
    item.reason = 'Profile did not open (went to ' + new URL(url).pathname + ')';
    await afterProfile(s, false);
    return { task: null };
  }

  return { task: null };
}

function knownInboxKeys(s) {
  const keys = new Set(s.seenKeys);
  s.queue.forEach((i) => {
    keys.add(i.key);
    if (i.conversationUrl) keys.add(i.conversationUrl);
  });
  return Array.from(keys);
}

// One conversation from the inbox was read.
async function onConversationFound(s, msg, sender) {
  if (!isFromActiveRun(s, msg, sender) || s.phase !== 'inbox') return { stop: true };
  await chrome.alarms.create('watchdog', { delayInMinutes: WATCHDOG_INBOX_MIN });

  const c = msg.conversation || {};
  const profileUrl = normalizeProfileUrl(c.profileUrl);

  if (c.key && !s.seenKeys.includes(c.key)) s.seenKeys.push(c.key);

  // Duplicates: same conversation, or same person → do not add again.
  const dupConversation = c.conversationUrl && s.queue.some((i) => i.conversationUrl === c.conversationUrl);
  const dupProfile = profileUrl && s.queue.some((i) => i.profileUrl === profileUrl);
  if (!dupConversation && !dupProfile) {
    let status = 'pending';
    let reason = '';
    if (c.skipReason) {
      status = 'skipped';
      reason = c.skipReason;
    } else if (!profileUrl) {
      status = 'skipped';
      reason = 'No profile link found in the conversation';
    }
    s.queue.push({
      key: c.key,
      name: c.name || '',
      conversationUrl: c.conversationUrl || '',
      lastMessageDate: c.lastMessageDate || '',
      profileUrl,
      status,
      reason,
      data: null,
      scrapedAt: ''
    });
  }
  s.activity = 'Collecting inbox… ' + s.queue.length + ' found';
  await saveState(s);
  return { ok: true };
}

async function onInboxHeartbeat(s, msg, sender) {
  if (!isFromActiveRun(s, msg, sender) || s.phase !== 'inbox') return { stop: true };
  await chrome.alarms.create('watchdog', { delayInMinutes: WATCHDOG_INBOX_MIN });
  if (msg.text) {
    s.activity = msg.text;
    await saveState(s);
  }
  return { ok: true };
}

async function onInboxDone(s, msg, sender) {
  if (!isFromActiveRun(s, msg, sender) || s.phase !== 'inbox') return { stop: true };
  s.inboxDone = true;
  s.phase = 'profiles';
  s.profilesSinceBreak = 0;
  // "Names + links only" mode: we are done — no profile pages are opened.
  if (isLinksOnly(s)) {
    const withLink = s.queue.filter((i) => i.profileUrl).length;
    await haltRun(s, 'finished', 'Inbox collected: ' + withLink + ' contacts with profile links. Press Export CSV.');
    return { ok: true };
  }
  // Wait a normal random gap before the first profile.
  return scheduleNext(s).then(() => ({ ok: true }));
}

async function onInboxError(s, msg, sender) {
  if (!isFromActiveRun(s, msg, sender)) return { ok: true };
  await haltRun(s, 'paused', msg.error || 'Inbox collection hit a problem.');
  return { ok: true };
}

// A profile page finished (or failed).
async function onProfileResult(s, msg, sender) {
  if (!isFromActiveRun(s, msg, sender) || msg.key !== s.currentKey) return { ignored: true };
  await chrome.alarms.clear('watchdog');

  const item = findItem(s, msg.key);
  recordVisit(s);

  if (msg.security) {
    await securityStop(s, msg.security);
    return { ok: true };
  }
  if (!item) {
    await scheduleNext(s);
    return { ok: true };
  }

  if (msg.ok) {
    const data = msg.data || {};
    // The same person can appear under two link styles (ACoAA… id and a
    // readable name). If we already have them, mark this one as a duplicate.
    const finalUrl = normalizeProfileUrl(data.profileUrl);
    const already = finalUrl && s.queue.find(
      (i) => i !== item && i.status === 'done' && i.data && normalizeProfileUrl(i.data.profileUrl) === finalUrl
    );
    if (already) {
      item.status = 'skipped';
      item.reason = 'Duplicate of ' + (already.name || finalUrl);
    } else {
      item.status = 'done';
      item.reason = '';
      item.data = data;
      item.scrapedAt = data.scrapedAt || new Date().toISOString();
    }
    await afterProfile(s, true);
  } else {
    item.status = 'failed';
    item.reason = msg.error || 'Unknown error';
    await afterProfile(s, false);
  }
  return { ok: true };
}

async function onSecurityCheck(s, msg, sender) {
  if (s.status === 'running' && sender.tab && sender.tab.id === s.workTabId) {
    await securityStop(s, msg.reason);
  }
  return { ok: true };
}

/* ---------------------------- Message router ---------------------------- */

async function handleMessage(msg, sender) {
  const s = await loadState();
  switch (msg && msg.type) {
    // From the popup
    case 'START':
      return startRun(s, msg.tabId);
    case 'PAUSE':
      if (s.status === 'running') await haltRun(s, 'paused', 'Paused by you.');
      return { ok: true };
    case 'RETRY_FAILED': {
      let n = 0;
      s.queue.forEach((i) => {
        if (i.status === 'failed') {
          i.status = 'pending';
          i.reason = '';
          n++;
        }
      });
      s.consecutiveFailures = 0;
      if (n && s.status === 'finished') {
        s.status = 'idle';
        s.reason = '';
      }
      await saveState(s);
      return { ok: true, count: n };
    }
    case 'CLEAR_CACHE':
      return clearCache(s);
    case 'SET_MODE': {
      if (s.status === 'running') return { ok: false, message: 'Pause first, then change the mode.' };
      s.settings.mode = msg.value === 'linksOnly' ? 'linksOnly' : 'full';
      if (s.status === 'finished') {
        s.status = 'idle';
        s.reason = '';
      }
      await saveState(s);
      return { ok: true, value: s.settings.mode };
    }
    case 'SET_DAILY_LIMIT': {
      let n = parseInt(msg.value, 10);
      if (!n || n < 1) n = 1;
      if (n > HARD_MAX_DAILY_LIMIT) n = HARD_MAX_DAILY_LIMIT;
      s.settings.dailyLimit = n;
      await saveState(s);
      return { ok: true, value: n };
    }

    // From the LinkedIn page (content.js)
    case 'PAGE_READY':
      return onPageReady(s, msg, sender);
    case 'CONVERSATION_FOUND':
      return onConversationFound(s, msg, sender);
    case 'INBOX_HEARTBEAT':
      return onInboxHeartbeat(s, msg, sender);
    case 'INBOX_DONE':
      return onInboxDone(s, msg, sender);
    case 'INBOX_ERROR':
      return onInboxError(s, msg, sender);
    case 'PROFILE_RESULT':
      return onProfileResult(s, msg, sender);
    case 'SECURITY_CHECK':
      return onSecurityCheck(s, msg, sender);
    default:
      return { ok: false, message: 'Unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  locked(() => handleMessage(msg, sender)).then(
    (res) => sendResponse(res),
    (err) => {
      console.error('[Collector]', err);
      sendResponse({ ok: false, message: String(err && err.message ? err.message : err) });
    }
  );
  return true; // we answer later (async)
});

/* ---------------------------- Timers ------------------------------------ */

chrome.alarms.onAlarm.addListener((alarm) =>
  locked(async () => {
    const s = await loadState();
    if (s.status !== 'running') return;

    if (alarm.name === 'nextStep') {
      await advance(s);
      return;
    }

    if (alarm.name === 'watchdog') {
      // The page stopped answering. Find out why.
      let url = '';
      try {
        url = (await chrome.tabs.get(s.workTabId)).url || '';
      } catch (e) {
        await haltRun(s, 'paused', 'The LinkedIn tab was closed.');
        return;
      }
      if (isSecurityUrl(url)) {
        await securityStop(s, 'page: ' + new URL(url).pathname);
        return;
      }
      if (s.phase === 'inbox') {
        await haltRun(s, 'paused', 'The inbox page stopped responding. Press Start to continue from where it stopped.');
        return;
      }
      const item = s.currentKey ? findItem(s, s.currentKey) : null;
      if (item) {
        recordVisit(s);
        item.status = 'failed';
        item.reason = 'Page did not finish loading in time';
      }
      await afterProfile(s, false);
    }
  })
);

/* ---------------------------- Tab / browser events ---------------------- */

// You closed the work tab → pause (state is already saved).
chrome.tabs.onRemoved.addListener((tabId) =>
  locked(async () => {
    const s = await loadState();
    if (s.status === 'running' && s.workTabId === tabId) {
      await haltRun(s, 'paused', 'The LinkedIn tab was closed.');
    }
  })
);

// The work tab jumped to a login / checkpoint page → stop at once.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || !isSecurityUrl(changeInfo.url)) return;
  locked(async () => {
    const s = await loadState();
    if (s.status === 'running' && s.workTabId === tabId) {
      await securityStop(s, 'page: ' + new URL(changeInfo.url).pathname);
    }
  });
});

// Chrome restarted or the extension was reloaded → never continue silently.
function pauseIfRunning(reason) {
  return locked(async () => {
    const s = await loadState();
    if (s.status === 'running') await haltRun(s, 'paused', reason);
  });
}
chrome.runtime.onStartup.addListener(() => pauseIfRunning('Chrome was restarted. Press Start to continue.'));
chrome.runtime.onInstalled.addListener(() => pauseIfRunning('The extension was reloaded. Press Start to continue.'));
