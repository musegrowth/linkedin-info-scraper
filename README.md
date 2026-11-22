# LinkedIn Inbox Profile Collector

A Chrome extension for **personal use on your own LinkedIn account**. It:

1. Goes through your LinkedIn **Messages** inbox and makes a list of everyone you have a conversation with.
2. Opens each person's profile **one by one, slowly**, and saves the details that are visible on the page.
3. Saves progress after every step, so you can stop and continue another day.
4. Lets you download everything as a **CSV** file (opens in Excel / Google Sheets).

It **never** asks for, stores, or types your LinkedIn password. It only works inside the Chrome window where you are already logged in.

> **Please read:** LinkedIn's User Agreement does not allow automated tools that collect data from its site. Even with the slow, careful limits built in here, using this tool can lead to LinkedIn warning or restricting your account. You use it at your own risk. Keep the limits low. The data you collect is other people's personal information, so keep the CSV private.

---

## 1. Install (one time, about 2 minutes)

1. Put this folder somewhere it will stay (for example `Documents\Linkedin Scraper`). Chrome loads the extension from this folder, so don't delete or move it later.
2. Open Chrome and type `chrome://extensions` in the address bar, then press Enter.
3. Turn on **Developer mode** (the switch in the top-right corner).
4. Click **Load unpacked** (top-left).
5. Choose this folder (the one that contains `manifest.json`) and click **Select Folder**.
6. "LinkedIn Inbox Profile Collector" now appears in the list.
7. Click the **puzzle-piece icon** in Chrome's toolbar, then the **pin** next to the extension, so its icon is always visible.

If you change any file later (for example `selectors.js`), go back to `chrome://extensions` and click the **reload ↻** arrow on the extension's card.

---

## 2. How to use it

1. Log in to LinkedIn in Chrome as you normally do.
2. Open **https://www.linkedin.com/messaging/** in a tab.
3. Click the extension icon, then press **Start**.
4. Leave that tab open. You can use other tabs and windows. It works best if the LinkedIn tab stays **visible** (for example in its own window). Chrome slows down hidden tabs, which only makes the tool slower.
5. Press **Pause** any time. Progress is saved.
6. Next day, open LinkedIn, click the icon, and press **Start** again. It continues where it stopped.
7. Press **Export CSV** whenever you want the results.

### Choose a mode (in the popup, before pressing Start)

| Mode | What it does |
|---|---|
| **Full (visit each profile)** | Collects the inbox, then opens each profile slowly and saves all its details. |
| **Names + links only** | Collects only each contact's **name and profile link** from the inbox. **No profile pages are opened**, and the tab stays on the Messages page. Much faster and lighter. Export CSV then gives a simple file: Name, Profile URL, Conversation URL, Last Message Date. |

You can only change the mode while the tool is not running. If you used "Names + links only" and later want the full details, switch to **Full** and press Start. It continues with the profile visits without collecting the inbox again.

### What happens after Start

**Phase 1 (Collecting inbox):**
- If you are already on the Messages page, it starts right there. **The page is not reloaded.**
- It scrolls the conversation list slowly (random amount, then a random 2–5 s wait).
- It opens each conversation for 3–7 s (random) to find the person's profile link in the header.
- Group chats and sponsored or LinkedIn system messages are marked **skipped** and never visited.
- The same person is only added once.
- It stops scrolling when 3 tries in a row load nothing new.

**Phase 2 (Visiting profiles):**
- It opens the next profile in the same tab, waits 4–10 s, and scrolls down in 2–4 small steps.
- It saves: name, headline, location, current company and job title, connection degree, and the email, phone, and website from **Contact info** if that is shown.
- It saves after **every** profile.
- Between profiles it waits 25–90 s (random). Every 10–15 profiles it takes a long break of 5–15 minutes.

### The popup

| Line | Meaning |
|---|---|
| Status | Idle / Collecting inbox / Visiting profiles / Paused / Stopped (reason) / Finished |
| Inbox: N found | Conversations in the list, including skipped ones |
| Profiles: … | done / left (pending) / skipped / failed |
| X of Y today | Profiles visited today and your daily limit |
| This hour | Profiles visited in the last 60 minutes (max 15) |

| Button | What it does |
|---|---|
| **Start** | Starts or continues (must be pressed while a LinkedIn tab is active) |
| **Pause** | Stops right away. Progress is saved. |
| **Export CSV** | Full mode: all rows, all columns. Names + links mode: name + profile link of each contact. |
| Mode | Full / Names + links only (see above) |
| **Retry failed** | Puts `failed` profiles back into the queue |
| **Clear cache** | Deletes all saved progress and data (asks first) |
| Daily limit | Default 40, max 80 |

---

## 3. Safety rules built in

- **Daily limit:** default 40 profiles a day (you can change it, maximum 80). When it's reached, the tool stops and shows *"Daily limit reached. Resume tomorrow."* The count resets automatically on the next calendar day.
- **Hourly limit:** at most 15 profiles in any 60 minutes. It waits automatically if needed.
- **Security checks:** if LinkedIn shows a CAPTCHA, a security verification, an "unusual activity" warning, a login page, or a rate-limit message, the tool **stops at once**, saves, and shows a red warning. It never tries to solve or get around it.
- **3 failures in a row:** if 3 profiles in a row fail to load, the tool stops and warns you.
- **One tab only.** There are no parallel requests and no hidden LinkedIn API calls. It only reads what is visible on the page.
- **Closing the tab** pauses the tool. Restarting Chrome or reloading the extension also pauses it; it never continues on its own after that.
- **Clear cache** keeps today's count and this hour's count, so clearing never lets you go over the limits.

---

## 4. If LinkedIn shows a security check

1. **Don't panic, and don't press Start again right away.** The tool has already stopped and saved everything.
2. Go to the LinkedIn tab and complete the check **yourself** (CAPTCHA, email code, log in again, and so on).
3. **Wait at least a day** before running the tool again.
4. When you continue, **lower the daily limit** (for example 20–25).
5. If LinkedIn warns you about your account more than once, stop using the tool.

---

## 5. Updating selectors when LinkedIn changes its layout

LinkedIn changes its page design from time to time. When that happens, some fields come back blank, or the inbox list isn't found. All the "where to look" rules are in **one file: `selectors.js`.**

### Easiest way: the "Diagnose this page" button
1. Open LinkedIn Messages and **click one conversation** so it is open on the right.
2. Click the extension icon and press **Diagnose this page**.
3. A file `linkedin-diagnose-….txt` is saved to your Downloads folder. It lists which selectors find something on your page and every profile link with the page structure around it. It does **not** include your message texts.
4. Send that file to whoever maintains the selectors (or use it yourself with the steps below).

### Find out what broke
1. On the LinkedIn page, right-click → **Inspect** → open the **Console** tab.
2. Look for yellow lines starting with `[Collector] Selector found nothing for "…"`. The name in quotes (for example `profile.headline`) is the entry to fix in `selectors.js`.

### Find a new selector
1. Right-click the thing on the page (for example the headline) → **Inspect**. The page code opens with that element highlighted.
2. Look for something **stable** on it or its parent:
   - an `aria-label="…"` → selector `[aria-label="…"]`
   - an `id="…"` → selector `#…`
   - a link containing `/in/` → selector `a[href*="/in/"]`
   - otherwise a class name → selector `.class-name` (these change most often)
3. Test it: in the Console, type `document.querySelector('YOUR-SELECTOR')` and press Enter. If it highlights the right thing, it works.

### Put it in
1. Open `selectors.js` in Notepad (or any text editor).
2. Find the entry (for example `headline: [ ... ]`) and add your selector as the **first** line of the list, in quotes, followed by a comma:
   ```js
   headline: [
     '.my-new-selector',
     '.text-body-medium.break-words',
     ...
   ],
   ```
3. Save the file, go to `chrome://extensions`, and click **reload ↻** on the extension.
4. Reload the LinkedIn tab and press **Start**.

If a profile fails because of a layout change, press **Retry failed** after fixing it.

---

## 6. Files

| File | What it is |
|---|---|
| `manifest.json` | Tells Chrome about the extension and its permissions |
| `background.js` | The "brain": queue, saved state, timers, limits, auto-stop |
| `content.js` | Runs inside LinkedIn pages: scrolls, reads, detects security checks |
| `selectors.js` | **All** page "where to look" rules (edit this when LinkedIn changes) |
| `popup.html` / `popup.css` / `popup.js` | The small control window |

Everything is stored only on your computer in `chrome.storage.local`. Nothing is sent anywhere.

---

## 7. How each situation is handled (test walkthrough)

1. **Fresh start, empty cache.** Start sends the tab to `/messaging/`, collects the inbox, then switches to profiles after one random 25–90 s wait.
2. **Pause during the inbox scroll, then resume.** Every conversation is saved as soon as it is read. On Start, it continues on the open Messages page without reloading and scrolls the list again. Conversations already handled are passed by **without being opened again**, and new ones are picked up from where it stopped.
3. **Pause during profiles, resume the next day.** The profile being read when you paused stays `pending` and is read again first. The daily count resets because the date changed.
4. **Daily limit reached.** The tool checks after every profile and on Start, then stops with "Daily limit reached. Resume tomorrow."
5. **Security check page.** This is caught three ways: by the page address (login, checkpoint, authwall), by CAPTCHA boxes that are actually visible on screen (hidden ones are ignored), and by warning text in headings, alerts, popups, or short error pages. The tool stops at once and shows a red warning.
6. **Profile fails to load.** If the name doesn't appear within 20 s, if LinkedIn sends the tab to a different page, or if there's no answer within 4 minutes, the profile is marked `failed`. After 3 in a row the tool stops with a warning.
7. **Clear cache, then start fresh.** Asks for confirmation, stops any run, and deletes the queue and data. The daily-limit setting and today's and this hour's counters are kept for safety.
8. **Export CSV.** With 0 profiles you get a file with only the column names. With many profiles you get one row per conversation (done, pending, skipped, failed), in UTF-8 with BOM so non-English names display correctly in Excel. Cells that start with `=`, `+`, `-` or `@` get a leading `'` so Excel doesn't run them as formulas.

---

## 8. Good to know

- **Last Message Date** is copied exactly as the inbox shows it ("Nov 3", "2:45 PM", "Mon").
- **Connection degree** is copied from the badge next to the name (1st / 2nd / 3rd).
- Contact info (email, phone) is usually visible only for **1st-degree** connections, so it is often blank for others. This is normal.
- If a person appears under two different link styles, the second visit is marked `skipped (Duplicate …)`.
- When resuming the inbox, a conversation whose date label changed (for example "2:45 PM" became "Mon") may be opened again for a few seconds. It is never added twice.
