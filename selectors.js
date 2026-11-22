/*
 * selectors.js — ALL the "where to look on the page" rules live here.
 *
 * LinkedIn changes its page design often. When the tool stops finding
 * something (a name, a headline, the inbox list...), this is the ONLY file
 * you need to edit. See README.md → "Updating selectors".
 *
 * How it works:
 *  - Every entry is a LIST of CSS selectors.
 *  - The tool tries them from top to bottom and uses the first one that
 *    finds something on the page.
 *  - So to fix something, add a new selector at the TOP of the list.
 *    You can keep the old ones below as backups.
 *  - If none of them match, the tool writes a warning in the console
 *    (right-click page → Inspect → Console) and leaves that field blank.
 *    It does not crash.
 *
 * Tip: stable things (aria-label, href containing "/in/", id) survive
 * LinkedIn redesigns much better than class names like "t-14 t-bold".
 */

var LIC_SELECTORS = {
  /* ------------------------------------------------------------------
   * INBOX PAGE  (https://www.linkedin.com/messaging/)
   * ------------------------------------------------------------------ */
  inbox: {
    // One row in the left-hand conversation list.
    listItem: [
      'li.msg-conversation-listitem',
      'li.msg-conversations-container__convo-item',
      '.msg-conversations-container__conversations-list > li',
      'ul[class*="conversations-list"] > li'
    ],

    // The part of a row you click to open the conversation.
    itemClickTarget: [
      'a[href*="/messaging/thread/"]',
      '.msg-conversation-listitem__link',
      '.msg-conversation-card__content--selectable',
      '[tabindex="0"]'
    ],

    // A direct link to the conversation, if the row has one.
    itemThreadLink: [
      'a[href*="/messaging/thread/"]'
    ],

    // The person's name in the row.
    itemName: [
      '.msg-conversation-listitem__participant-names',
      '.msg-conversation-card__participant-names',
      'h3'
    ],

    // The date of the last message shown in the row ("Nov 3", "2:45 PM", "Mon").
    itemDate: [
      'time.msg-conversation-listitem__time-stamp',
      '.msg-conversation-card__time-stamp',
      'time'
    ],

    // A link to the person's profile inside the row (usually NOT present —
    // then the tool opens the conversation to find it).
    itemProfileLink: [
      'a[href*="/in/"]'
    ],

    // Something that only appears on GROUP chat rows (several small photos).
    itemGroupHint: [
      '[class*="facepile-grid--group-size"]',
      '.msg-facepile-grid--group-size-2',
      '.msg-facepile-grid--group-size-3'
    ],

    // Small label "pills" on a row, e.g. "Sponsored".
    itemLabelPill: [
      '.msg-conversation-card__pill',
      '.msg-conversation-listitem__pill',
      '[class*="__pill"]'
    ],

    // Optional "Load more conversations" button at the bottom of the list.
    loadMoreButton: [
      '.msg-conversations-container__load-more button',
      'button[class*="load-more"]'
    ]
  },

  // Text that marks a row as a LinkedIn system / advert message (case-insensitive).
  sponsoredPillPattern: /sponsored|promoted|advert/i,
  // Sender names that are LinkedIn itself, not a person.
  systemSenderPattern: /^linkedin\b/i,

  /* ------------------------------------------------------------------
   * OPEN CONVERSATION (right-hand side of the inbox)
   * ------------------------------------------------------------------ */
  thread: {
    // Link to the other person's profile in the conversation header.
    profileLink: [
      'a.msg-thread__link-to-profile[href*="/in/"]',
      '.msg-title-bar a[href*="/in/"]',
      '.msg-entity-lockup a[href*="/in/"]',
      '.msg-s-profile-card a[href*="/in/"]'
    ],

    // The name shown at the top of the open conversation.
    headerName: [
      '.msg-entity-lockup__entity-title',
      'h2.msg-entity-lockup__entity-title',
      '.msg-thread__link-to-profile',
      '.msg-title-bar h2'
    ],

    // The whole open-conversation area (used as a last-resort search area
    // for a profile link whose text matches the person's name).
    pane: [
      '.msg-convo-wrapper',
      '.msg-thread',
      '.scaffold-layout__detail',
      'main'
    ]
  },

  // Header text that means "this is a group conversation".
  groupHeaderPattern: /\b\d+\s+participants?\b|\bparticipants\b/i,

  /* ------------------------------------------------------------------
   * PROFILE PAGE  (https://www.linkedin.com/in/...)
   * ------------------------------------------------------------------ */
  profile: {
    // The person's full name (big heading at the top).
    name: [
      'main h1',
      'h1.text-heading-xlarge',
      'h1'
    ],

    // The line under the name, e.g. "Founder at Acme".
    headline: [
      '.text-body-medium.break-words',
      '[data-generated-suggestion-target]',
      '.pv-text-details__left-panel .text-body-medium'
    ],

    // Location, e.g. "Dhaka, Bangladesh".
    location: [
      '.text-body-small.inline.t-black--light.break-words',
      '.pv-text-details__left-panel .text-body-small',
      'span.text-body-small.inline'
    ],

    // "1st", "2nd", "3rd+" badge next to the name.
    degree: [
      '.dist-value',
      '.distance-badge .visually-hidden',
      '[class*="distance-badge"]'
    ],

    // The "Contact info" link under the name.
    contactInfoLink: [
      'a#top-card-text-details-contact-info',
      'a[href*="/overlay/contact-info/"]'
    ],

    // Experience section: an invisible anchor with id="experience" sits
    // inside it. If that ever disappears, the tool also looks for a
    // section whose heading says "Experience".
    experienceAnchor: [
      '#experience'
    ],
    experienceHeadingPattern: /^experience$/i,

    // One job row inside the Experience section.
    experienceItem: [
      'li.artdeco-list__item',
      'li.pvs-list__paged-list-item',
      'li'
    ],

    // Inside a job row: the bold title line, the normal line, the grey line.
    expBold: [
      '.t-bold span[aria-hidden="true"]',
      '.t-bold'
    ],
    expNormal: [
      '.t-14.t-normal:not(.t-black--light) span[aria-hidden="true"]',
      '.t-14.t-normal:not(.t-black--light)'
    ],

    // Text meaning "this job is current" (several languages).
    currentJobPattern: /present|heute|actualidad|présent|presente|attuale|huidig|obecnie|şu anda|现在|至今/i,

    // Text that means the profile does not exist / is unavailable.
    notFoundPattern: /this page doesn.t exist|profile (is )?unavailable|page not found|this profile is not available/i
  },

  /* ------------------------------------------------------------------
   * CONTACT INFO POPUP (opened from a profile)
   * ------------------------------------------------------------------ */
  contact: {
    // The popup itself.
    dialog: [
      '[role="dialog"] .pv-contact-info',
      '.artdeco-modal[role="dialog"]',
      '[role="dialog"]'
    ],
    // The X / close button of the popup.
    closeButton: [
      'button[aria-label="Dismiss"]',
      'button.artdeco-modal__dismiss',
      'button[aria-label*="Close"]',
      'button[aria-label*="close"]'
    ],
    // Section headings inside the popup, e.g. "Email", "Phone", "Website".
    sectionHeading: [
      'h3',
      'h2'
    ],
    emailHeadingPattern: /e-?mail/i,
    phoneHeadingPattern: /phone|telefon|téléphone|teléfono/i,
    websiteHeadingPattern: /website|web site|sitio|site web/i
  },

  /* ------------------------------------------------------------------
   * SECURITY CHECKS — if any of these are seen, the tool STOPS at once.
   * It never tries to solve or get around them.
   * ------------------------------------------------------------------ */
  security: {
    // Page addresses (the part after linkedin.com) that mean
    // login / checkpoint / verification.
    urlPaths: [
      /^\/checkpoint/i,
      /^\/login/i,
      /^\/uas\//i,
      /^\/authwall/i,
      /^\/signup/i,
      /^\/challenge/i,
      /^\/security/i
    ],

    // Elements that are CAPTCHAs or verification boxes.
    // They only count if they are actually VISIBLE on screen (LinkedIn keeps
    // some hidden ones on normal pages, which must not trigger a stop).
    elements: [
      'iframe[src*="captcha"]',
      'iframe[title*="captcha" i]',
      '#captcha-internal',
      'iframe[src*="/checkpoint/challenge"]',
      'form[action*="/checkpoint/challenge"]'
    ],
    // Minimum size (pixels) for such an element to count as visible.
    minVisibleSize: 60,

    // Where to look for warning text (headings, alerts, popups, page title).
    textContainers: [
      'h1',
      'h2',
      '[role="alert"]',
      '[role="alertdialog"]',
      '[role="dialog"] h2',
      '.artdeco-toast-item'
    ],

    // Warning phrases (lower-case).
    phrases: [
      'security verification',
      'security check',
      'quick security check',
      'verify you are human',
      "verify you're human",
      'are you a robot',
      'unusual activity',
      'restricted your account',
      'account has been restricted',
      'account is restricted',
      'temporarily restricted',
      'too many requests',
      'rate limit',
      'commercial use limit',
      'sign in to view',
      'join linkedin to view'
    ]
  }
};
