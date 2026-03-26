/**
 * LinkedIn Automation — Centralized Configuration
 */

import path from 'path';

const ROOT = process.env.NANOCLAW_ROOT || process.cwd();

export const config = {
  // Chrome / browser
  chromePath: process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  browserDataDir: path.join(ROOT, 'data/li-browser-profile'),
  authPath:       path.join(ROOT, 'data/li-auth.json'),
  limitsPath:     path.join(ROOT, 'data/li-daily-limits.json'),

  // Browser settings
  viewport: { width: 1280, height: 900 },
  chromeArgs: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  chromeIgnoreDefaultArgs: ['--enable-automation'],

  // Safety limits (per day)
  limits: {
    maxConnectionsPerDay:  parseInt(process.env.LI_MAX_CONNECTIONS_PER_DAY  || '25'),
    maxMessagesPerDay:     parseInt(process.env.LI_MAX_MESSAGES_PER_DAY     || '40'),
    maxProfileViewsPerDay: parseInt(process.env.LI_MAX_PROFILE_VIEWS_PER_DAY|| '80'),
    maxLikesPerDay:        parseInt(process.env.LI_MAX_LIKES_PER_DAY        || '50'),
    maxCommentsPerDay:     parseInt(process.env.LI_MAX_COMMENTS_PER_DAY     || '20'),
    maxFollowsPerDay:      parseInt(process.env.LI_MAX_FOLLOWS_PER_DAY      || '30'),
  },

  // Human-like delays (ms)
  delays: {
    minMs:           parseInt(process.env.LI_MIN_DELAY_MS || '3000'),
    maxMs:           parseInt(process.env.LI_MAX_DELAY_MS || '9000'),
    afterPageLoad:   2500,
    afterClick:      1500,
    afterType:       800,
    betweenActions:  4000,
  },

  // Timeouts (ms)
  timeouts: {
    navigation:    30000,
    elementWait:   8000,
    secondaryWait: 5000,   // fallback menus, confirm dialogs, optional elements
    scriptMax:     180000,
  },

  // Notion
  notion: {
    apiKey:          process.env.NOTION_API_KEY        || '',
    leadsDatabaseId: process.env.NOTION_LEADS_DB_ID   || '',
  },

  // LinkedIn URLs
  urls: {
    base:      'https://www.linkedin.com',
    feed:      'https://www.linkedin.com/feed/',
    search:    'https://www.linkedin.com/search/results/people/',
    messaging: 'https://www.linkedin.com/messaging/',
    login:     'https://www.linkedin.com/login',
  },

  // LinkedIn selectors (update if LinkedIn redesigns their UI)
  selectors: {
    // Profile page
    connectBtn:        ':is(button, a)[aria-label*="connect" i]',
    followBtn:         ':is(button, a)[aria-label*="Follow"]',
    unfollowBtn:       ':is(button, a)[aria-label*="Unfollow"], :is(button, a)[aria-label*="Following"]',
    messageBtn:        ':is(button[aria-label*="Message"], a[href*="messaging/compose"])',
    pendingBtn:        ':is(button, a)[aria-label*="Pending"], :is(button, a)[aria-label*="Withdraw"]',
    profileName:       'h1',
    profileHeadline:   'div.text-body-medium',
    profileLocation:   'span.text-body-small.inline.t-black--light',
    profileAbout:      'div#about ~ div .full-width span[aria-hidden="true"]',
    skillsSection:     'div#skills',
    endorseBtn:        'button[aria-label*="Endorse"]',

    // Connect modal
    addNoteBtn:        'button[aria-label="Add a note"]',
    noteTextarea:      'textarea[name="message"]',
    sendNowBtn:        'button[aria-label="Send invitation"]',
    sendWithoutNoteBtn:'button[aria-label="Send without a note"]',

    // Messaging
    msgCompose:        'div.msg-form__contenteditable',
    msgSendBtn:        'button.msg-form__send-button',

    // Posts
    likeBtn:           'button[aria-label*="Like"][aria-pressed="false"]',
    reactionsMenu:     'div.reactions-menu',
    commentBox:        'div.comments-comment-box__form div[contenteditable]',
    commentSubmitBtn:  'button.comments-comment-box__submit-button',
    shareBtn:          'button[aria-label*="Repost"], button[aria-label*="Share"]',
    shareTextarea:     'div.share-box-text div[contenteditable]',
    shareSubmitBtn:    'button[aria-label*="Post"]',

    // Search results (updated 2026-03 — LinkedIn randomises class names now)
    searchResultsList: '[data-chameleon-result-urn]',
    resultProfileLink: 'a[href*="/in/"]',
    resultName:        'span[dir="ltr"] > span[aria-hidden="true"]',
    resultHeadline:    '.t-14.t-black.t-normal',
    resultLocation:    '.t-14.t-normal:not(.t-black):not(.t-black--light)',
    nextPageBtn:       'button[aria-label="Next"]',

    // Post engagers
    engagedList:       'div.social-details-reactors-tab-body-list, div[class*="reactors-tab-body-list"]',
    engagedItem:       'li.social-details-reactors-list-item, li[class*="reactors-list-item"]',

    // Login
    emailInput:        '#username',
    passwordInput:     '#password',
    loginBtn:          'button[type="submit"]',
  },
};

export type Config = typeof config;
