/*
 * content.js — runs inside LinkedIn pages.
 *
 * It does nothing on its own. When a LinkedIn page loads, it asks the
 * background ("brain") whether there is a job for this tab:
 *   - INBOX   → scroll the conversation list and read each conversation
 *   - PROFILE → read the visible details of one profile
 *
 * It only reads what is visible on the page. It never calls LinkedIn's
 * internal API and never types anything.
 *
 * All "where to look" rules come from selectors.js (LIC_SELECTORS).
 */
(function () {
  // Run only once per page. (If the extension was reloaded, the old copy is
  // "dead" — chrome.runtime.id is gone — so a fresh copy may take over.)
  if (window.__licCollectorAlive && window.__licCollectorAlive()) return;
  window.__licCollectorAlive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  const S = LIC_SELECTORS;
  const LOG = '[Collector]';

  /* ---------------------------- Stop / sleep ---------------------------- */

  class StopError extends Error {}
  let stopped = false;
  const stopListeners = new Set();

  function stopNow() {
    stopped = true;
    stopListeners.forEach((fn) => fn());
    stopListeners.clear();
  }

  // Messages from the background:
  //  ABORT → stop what you are doing (Pause pressed, limit reached, ...)
  //  KICK  → Start was pressed while this page is already open: begin work
  //          right here, WITHOUT reloading the page.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'ABORT') {
      console.log(LOG, 'Stop requested.');
      stopNow();
    } else if (msg.type === 'KICK') {
      console.log(LOG, 'Start pressed — working on this page without reloading.');
      requestTask();
    }
  });

  // Wait ms milliseconds. Ends early (with StopError) if we are told to stop.
  function sleep(ms) {
    return new Promise((resolve, reject) => {
      if (stopped) return reject(new StopError());
      const onStop = () => {
        clearTimeout(timer);
        reject(new StopError());
      };
      const timer = setTimeout(() => {
        stopListeners.delete(onStop);
        resolve();
      }, ms);
      stopListeners.add(onStop);
    });
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }
  function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
  }
  // Random wait between minMs and maxMs.
  function sleepRange(minMs, maxMs) {
    return sleep(rand(minMs, maxMs));
  }

  // Check fn() every half second until it returns something, or time runs out.
  async function waitFor(fn, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (true) {
      let value = null;
      try { value = fn(); } catch (e) { value = null; }
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(500);
    }
  }

  /* ---------------------------- Finding things -------------------------- */

  const warned = new Set();
  function warnMissing(what) {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(LOG, 'Selector found nothing for "' + what + '". Field left blank. (Update selectors.js if this keeps happening.)');
  }

  // First element that matches any selector in the list.
  function qs(list, root) {
    root = root || document;
    for (const sel of list) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        console.warn(LOG, 'Bad selector:', sel);
      }
    }
    return null;
  }

  // All elements matching the first selector in the list that finds any.
  function qsa(list, root) {
    root = root || document;
    for (const sel of list) {
      try {
        const els = root.querySelectorAll(sel);
        if (els.length) return Array.from(els);
      } catch (e) {
        console.warn(LOG, 'Bad selector:', sel);
      }
    }
    return [];
  }

  // Visible text of an element, cleaned up.
  function text(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // First non-empty line of an element's text.
  function firstLine(el) {
    if (!el) return '';
    const lines = (el.innerText || el.textContent || '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[0] || '';
  }

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

  function cleanThreadUrl(url) {
    const m = (url || '').match(/\/messaging\/thread\/([^/?#]+)/);
    return m ? 'https://www.linkedin.com/messaging/thread/' + m[1] + '/' : '';
  }

  function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /* ---------------------------- Talking to the background --------------- */

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      // Usually "Extension context invalidated" after reloading the extension.
      console.warn(LOG, 'Could not reach the extension:', e && e.message);
      stopNow();
      return null;
    }
  }

  /* ---------------------------- Security checks ------------------------- */

  // True only if the element is shown on screen at a real size
  // (not hidden, not 0×0, not invisible).
  function isReallyVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const min = S.security.minVisibleSize || 60;
    if (r.width < min || r.height < min) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    return el.offsetParent !== null || st.position === 'fixed';
  }

  // Returns a short description if the page looks like a CAPTCHA, login,
  // verification, restriction or rate-limit page. Otherwise ''.
  function detectSecurityCheck() {
    try {
      const path = location.pathname;
      for (const re of S.security.urlPaths) {
        if (re.test(path)) return 'page: ' + path;
      }
      for (const sel of S.security.elements) {
        let els = [];
        try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
        const visible = els.find(isReallyVisible);
        if (visible) {
          console.warn(LOG, 'Visible verification element matched selector:', sel, visible);
          return 'CAPTCHA / verification box on the page';
        }
      }
      const pieces = [document.title];
      document.querySelectorAll(S.security.textContainers.join(',')).forEach((el, i) => {
        if (i < 80) pieces.push(text(el));
      });
      // Error pages are short; long normal pages are not scanned in full
      // (so a message or an "About" text cannot cause a false alarm).
      const bodyText = document.body ? document.body.innerText || '' : '';
      if (bodyText.length < 3000) pieces.push(bodyText);
      const hay = pieces.join('\n').toLowerCase();
      for (const phrase of S.security.phrases) {
        if (hay.includes(phrase)) return 'the page says "' + phrase + '"';
      }
    } catch (e) {
      console.warn(LOG, 'Security check error:', e);
    }
    return '';
  }

  // Stops everything if a security check is visible. Never tries to solve it.
  async function stopIfSecurityCheck(runId) {
    const reason = detectSecurityCheck();
    if (reason) {
      console.warn(LOG, 'SECURITY CHECK DETECTED — stopping:', reason);
      await send({ type: 'SECURITY_CHECK', runId, reason });
      throw new StopError();
    }
  }

  /* =====================================================================
   * PHASE 1 — INBOX
   * ===================================================================== */

  function looksLikeGroupName(name) {
    // "Anna Lee, Tom Hart" or "Anna, Tom and 3 others". A single name with a
    // title like "Jane Doe, PhD" is NOT treated as a group.
    if (/\band \d+ others?\b/i.test(name)) return true;
    const parts = name.split(/,| & /).map((p) => p.trim()).filter(Boolean);
    return parts.length >= 2 && parts.filter((p) => p.split(/\s+/).length >= 2).length >= 2;
  }

  // Reads one row of the conversation list.
  function readListItem(li) {
    const name = firstLine(qs(S.inbox.itemName, li));
    const date = text(qs(S.inbox.itemDate, li));
    const threadLink = qs(S.inbox.itemThreadLink, li);
    const conversationUrl = threadLink ? cleanThreadUrl(threadLink.href) : '';
    const profileLink = qs(S.inbox.itemProfileLink, li);
    const profileUrl = profileLink ? normalizeProfileUrl(profileLink.href) : '';

    let skipReason = '';
    const pills = qsa(S.inbox.itemLabelPill, li).map(text).join(' ');
    if (qs(S.inbox.itemGroupHint, li) || looksLikeGroupName(name)) {
      skipReason = 'Group chat';
    } else if (S.sponsoredPillPattern.test(pills)) {
      skipReason = 'Sponsored / LinkedIn system message';
    } else if (S.systemSenderPattern.test(name)) {
      skipReason = 'LinkedIn system message';
    }

    return {
      key: conversationUrl || name + '|' + date,
      name,
      lastMessageDate: date,
      conversationUrl,
      profileUrl,
      skipReason
    };
  }

  // Finds the other person's profile link in the open conversation.
  function findThreadProfileLink(name) {
    const direct = qs(S.thread.profileLink);
    if (direct) return direct;
    // Backup: any /in/ link in the conversation whose text matches the name.
    const pane = qs(S.thread.pane);
    if (!pane || !name) return null;
    const want = name.toLowerCase();
    for (const a of pane.querySelectorAll('a[href*="/in/"]')) {
      const label = [
        a.innerText || '',
        a.getAttribute('aria-label') || '',
        Array.from(a.querySelectorAll('img')).map((i) => i.alt || '').join(' ')
      ].join(' ').toLowerCase();
      if (label.includes(want)) return a;
    }
    return null;
  }

  // Opens one conversation and reads the profile link from its header.
  async function openConversation(li, info, runId) {
    const target = qs(S.inbox.itemClickTarget, li) || li;
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    await sleepRange(400, 1200);
    target.click();

    // Wait a random 3–7 seconds, like a person glancing at the conversation.
    await sleepRange(3000, 7000);
    await stopIfSecurityCheck(runId);

    // Make sure the conversation on screen is the one we clicked.
    const want = (info.name || '').toLowerCase();
    await waitFor(() => {
      const h = text(qs(S.thread.headerName)).toLowerCase();
      return want && h && (h.includes(want) || want.includes(h));
    }, 6000);

    if (!info.conversationUrl && location.pathname.includes('/messaging/thread/')) {
      info.conversationUrl = cleanThreadUrl(location.href);
    }

    const header = text(qs(S.thread.headerName));
    if (!header) warnMissing('thread.headerName');
    if (S.groupHeaderPattern.test(header)) {
      info.skipReason = 'Group chat';
      return;
    }

    const link = findThreadProfileLink(info.name);
    if (link) {
      info.profileUrl = normalizeProfileUrl(link.href);
    } else {
      warnMissing('thread.profileLink');
      info.skipReason = info.skipReason || 'No profile link found (group chat, company page, or closed account?)';
    }
  }

  // The scrollable box that holds the conversation list.
  function findScroller(fromEl) {
    let el = fromEl ? fromEl.parentElement : null;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isAtBottom(el) {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  }

  async function runInbox(task) {
    const runId = task.runId;
    const known = new Set(task.knownKeys || []);
    console.log(LOG, 'Inbox: starting. Already known:', known.size);

    const first = await waitFor(() => qs(S.inbox.listItem), 20000);
    await stopIfSecurityCheck(runId);
    if (!first) {
      warnMissing('inbox.listItem');
      await send({
        type: 'INBOX_ERROR',
        runId,
        error: 'Could not find the conversation list. LinkedIn may have changed its layout (see README → Updating selectors).'
      });
      return;
    }
    await sleepRange(2000, 4000);

    const loadedKeys = new Set(); // every row seen in the page so far
    let triesWithoutNew = 0;

    while (true) {
      await stopIfSecurityCheck(runId);

      // 1) Handle every visible row we have not handled before.
      const rows = qsa(S.inbox.listItem);
      for (const li of rows) {
        if (!li.isConnected) continue;
        const info = readListItem(li);
        if (!info.name) continue;
        loadedKeys.add(info.key);
        if (known.has(info.key) || (info.conversationUrl && known.has(info.conversationUrl))) continue;
        known.add(info.key);

        if (!info.skipReason && !info.profileUrl) {
          await openConversation(li, info, runId);
        }
        if (info.conversationUrl) known.add(info.conversationUrl);

        console.log(LOG, 'Conversation:', info.name, info.skipReason ? '(skipped: ' + info.skipReason + ')' : info.profileUrl);
        const r = await send({ type: 'CONVERSATION_FOUND', runId, conversation: info });
        if (!r || r.stop) throw new StopError();
      }

      // 2) Scroll the list down by a random amount.
      const scroller = findScroller(rows[0]);
      const sizeBefore = loadedKeys.size;
      const topBefore = scroller.scrollTop;
      const wasAtBottom = isAtBottom(scroller);
      if (wasAtBottom) {
        const more = qs(S.inbox.loadMoreButton);
        if (more && more.offsetParent !== null) more.click();
      }
      scroller.scrollBy({ top: rand(250, 700), behavior: 'smooth' });

      // 3) Wait a random 2–5 seconds for older conversations to load.
      await sleepRange(2000, 5000);

      qsa(S.inbox.listItem).forEach((li) => {
        const info = readListItem(li);
        if (info.name) loadedKeys.add(info.key);
      });
      const moved = scroller.scrollTop !== topBefore;

      if (loadedKeys.size > sizeBefore) {
        triesWithoutNew = 0;
      } else if (wasAtBottom || !moved || isAtBottom(scroller)) {
        triesWithoutNew += 1; // at the end of the list and nothing new came
      }

      const hb = await send({
        type: 'INBOX_HEARTBEAT',
        runId,
        text: 'Scrolling inbox… ' + loadedKeys.size + ' conversations loaded on the page'
      });
      if (!hb || hb.stop) throw new StopError();

      // 4) Stop when 3 tries in a row brought nothing new.
      if (triesWithoutNew >= 3) break;
    }

    console.log(LOG, 'Inbox: finished.');
    await send({ type: 'INBOX_DONE', runId });
  }

  /* =====================================================================
   * PHASE 2 — PROFILE
   * ===================================================================== */

  // Scroll the page a little, like a person reading.
  function scrollPageBy(px) {
    const before = window.scrollY;
    window.scrollBy({ top: px, behavior: 'smooth' });
    // Some LinkedIn layouts scroll inside <main> instead of the window.
    setTimeout(() => {
      if (window.scrollY === before) {
        const main = document.querySelector('main');
        const box = main ? findScroller(main.firstElementChild || main) : null;
        if (box) box.scrollBy({ top: px, behavior: 'smooth' });
      }
    }, 300);
  }

  // Visible text pieces of one Experience row (not of rows nested inside it).
  function ownSpans(li, list) {
    return qsa(list, li)
      .filter((el) => el.closest('li') === li)
      .map(text)
      .filter(Boolean);
  }

  function readCurrentJob() {
    const out = { company: '', jobTitle: '' };

    let section = null;
    const anchor = qs(S.profile.experienceAnchor);
    if (anchor) section = anchor.closest('section');
    if (!section) {
      section = Array.from(document.querySelectorAll('section')).find((sec) =>
        S.profile.experienceHeadingPattern.test(firstLine(sec.querySelector('h2')))
      );
    }
    if (!section) {
      warnMissing('profile.experience section');
      return out;
    }

    // Top-level job rows only (not the roles nested inside a company).
    const all = qsa(S.profile.experienceItem, section);
    const rows = all.filter((li) => {
      const parentLi = li.parentElement ? li.parentElement.closest('li') : null;
      return !parentLi || !section.contains(parentLi);
    });
    if (!rows.length) {
      warnMissing('profile.experienceItem');
      return out;
    }

    // Prefer a row that says "Present"; otherwise the first row.
    const row = rows.find((li) => S.profile.currentJobPattern.test(text(li))) || rows[0];

    // Roles nested inside this row (several jobs at the same company).
    const nestedRoles = Array.from(row.querySelectorAll('li')).filter(
      (li) => li !== row && qs(S.profile.expBold, li)
    );

    const bold = ownSpans(row, S.profile.expBold);
    const normal = ownSpans(row, S.profile.expNormal);

    if (nestedRoles.length) {
      // Company is the row title, job title is the (current) nested role.
      out.company = bold[0] || '';
      const role = nestedRoles.find((li) => S.profile.currentJobPattern.test(text(li))) || nestedRoles[0];
      out.jobTitle = text(qs(S.profile.expBold, role));
    } else {
      out.jobTitle = bold[0] || '';
      out.company = (normal[0] || '').split(' · ')[0].trim();
    }

    // Last resort: use the first two lines of text in the row.
    if (!out.jobTitle && !out.company) {
      const lines = (row.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
      out.jobTitle = lines[0] || '';
      out.company = (lines[1] || '').split(' · ')[0].trim();
    }
    if (!out.jobTitle) warnMissing('profile.experience job title');
    if (!out.company) warnMissing('profile.experience company');
    return out;
  }

  function readTopCard() {
    const h1 = qs(S.profile.name);
    const top = (h1 && h1.closest('section')) || document;

    const name = firstLine(h1);
    const headline = text(qs(S.profile.headline, top));
    const loc = text(qs(S.profile.location, top));

    let degree = '';
    const degEl = qs(S.profile.degree, top);
    const degMatch = (text(degEl) || text(top).slice(0, 600)).match(/\b(1st|2nd|3rd\+?)\b/i);
    if (degMatch) degree = degMatch[1].replace('+', '');

    if (!name) warnMissing('profile.name');
    if (!headline) warnMissing('profile.headline');
    if (!loc) warnMissing('profile.location');
    if (!degree) warnMissing('profile.degree');

    return { name, headline, location: loc, degree };
  }

  // Undo LinkedIn's redirect wrapper on website links.
  function realLink(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.hostname.endsWith('linkedin.com') && u.searchParams.get('url')) return u.searchParams.get('url');
      return u.href;
    } catch (e) {
      return href || '';
    }
  }

  async function closeContactDialog() {
    const dialog = qs(S.contact.dialog);
    if (!dialog) return;
    const btn = qs(S.contact.closeButton, dialog) || qs(S.contact.closeButton);
    if (btn) {
      btn.click();
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await sleepRange(800, 1800);
    if (qs(S.contact.dialog) && location.pathname.includes('/overlay/')) {
      history.back();
      await sleepRange(800, 1500);
    }
  }

  async function readContactInfo(runId) {
    const out = { email: '', phone: '', website: '' };
    const link = qs(S.profile.contactInfoLink);
    if (!link) {
      console.log(LOG, 'No "Contact info" link on this profile.');
      return out;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleepRange(1000, 2500);
    link.click();

    const dialog = await waitFor(() => qs(S.contact.dialog), 8000);
    await stopIfSecurityCheck(runId);
    if (!dialog) {
      warnMissing('contact.dialog');
      return out;
    }
    await sleepRange(1500, 3500); // time to "read" the popup

    const emails = new Set();
    const phones = new Set();
    const sites = new Set();

    dialog.querySelectorAll('a[href^="mailto:"]').forEach((a) => emails.add(a.href.replace(/^mailto:/i, '').trim()));
    dialog.querySelectorAll('a[href^="tel:"]').forEach((a) => phones.add(text(a) || a.href.replace(/^tel:/i, '')));

    qsa(S.contact.sectionHeading, dialog).forEach((h) => {
      const heading = text(h);
      const box = h.closest('section') || h.parentElement;
      if (!box) return;
      if (S.contact.emailHeadingPattern.test(heading)) {
        box.querySelectorAll('a').forEach((a) => {
          const t = text(a);
          if (t.includes('@')) emails.add(t);
        });
      } else if (S.contact.phoneHeadingPattern.test(heading)) {
        const items = box.querySelectorAll('li');
        (items.length ? Array.from(items) : [box]).forEach((li) => {
          const first = li.querySelector('span');
          const t = text(first || li).replace(heading, '').trim();
          if (t) phones.add(t);
        });
      } else if (S.contact.websiteHeadingPattern.test(heading)) {
        box.querySelectorAll('a[href]').forEach((a) => {
          const url = realLink(a.getAttribute('href'));
          if (url && !/linkedin\.com\/in\//i.test(url)) sites.add(url);
        });
      }
    });

    out.email = Array.from(emails).join('; ');
    out.phone = Array.from(phones).join('; ');
    out.website = Array.from(sites).join('; ');

    await closeContactDialog();
    return out;
  }

  async function runProfile(task) {
    const runId = task.runId;
    const base = { type: 'PROFILE_RESULT', runId, key: task.key };
    console.log(LOG, 'Profile: reading', task.name || location.href);

    // Wait until the page has fully loaded and the name is on screen.
    if (document.readyState !== 'complete') {
      await waitFor(() => document.readyState === 'complete', 15000);
    }
    const h1 = await waitFor(() => qs(S.profile.name), 20000);

    const sec = detectSecurityCheck();
    if (sec) return send(Object.assign({}, base, { ok: false, security: sec }));

    if (!h1) {
      const bodyText = document.body ? document.body.innerText || '' : '';
      const notFound = S.profile.notFoundPattern.test(bodyText.slice(0, 5000)) || /\/404|unavailable/.test(location.pathname);
      return send(Object.assign({}, base, {
        ok: false,
        error: notFound ? 'Profile not available' : 'Profile did not load (name not found on page)'
      }));
    }

    // Wait a random 4–10 seconds before reading anything.
    await sleepRange(4000, 10000);
    await stopIfSecurityCheck(runId);

    // Scroll down slowly in 2–4 small random steps.
    const steps = randInt(2, 4);
    for (let i = 0; i < steps; i++) {
      scrollPageBy(rand(250, 700));
      await sleepRange(1500, 4000);
    }
    await stopIfSecurityCheck(runId);

    const top = readTopCard();
    const job = readCurrentJob();
    const contact = await readContactInfo(runId);
    await stopIfSecurityCheck(runId);

    const data = {
      name: top.name || task.name || '',
      headline: top.headline,
      location: top.location,
      degree: top.degree,
      company: job.company,
      jobTitle: job.jobTitle,
      email: contact.email,
      phone: contact.phone,
      website: contact.website,
      profileUrl: normalizeProfileUrl(location.href),
      scrapedAt: nowStamp()
    };
    console.log(LOG, 'Profile read:', data);
    return send(Object.assign({}, base, { ok: true, data }));
  }

  /* ---------------------------- Start-up -------------------------------- */

  let taskRunning = false;

  // Asks the background "is there a job for this tab?" and does it.
  // Called when the page loads, and again (KICK) when Start is pressed
  // while this page is already open.
  async function requestTask() {
    // If an earlier job on this page was just stopped, let it finish stopping.
    const until = Date.now() + 15000;
    while (taskRunning && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (taskRunning) return;
    stopped = false;

    const res = await send({ type: 'PAGE_READY', url: location.href, security: detectSecurityCheck() });
    if (!res || !res.task) return; // not the work tab, or not running

    taskRunning = true;
    try {
      if (res.task === 'INBOX') await runInbox(res);
      else if (res.task === 'PROFILE') await runProfile(res);
    } catch (e) {
      if (e instanceof StopError) {
        console.log(LOG, 'Stopped.');
        return;
      }
      console.error(LOG, 'Unexpected error:', e);
      if (res.task === 'PROFILE') {
        await send({ type: 'PROFILE_RESULT', runId: res.runId, key: res.key, ok: false, error: 'Script error: ' + e.message });
      } else {
        await send({ type: 'INBOX_ERROR', runId: res.runId, error: 'Inbox error: ' + e.message + '. Press Start to continue.' });
      }
    } finally {
      taskRunning = false;
    }
  }

  requestTask();
})();
