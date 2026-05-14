/**
 * X (Twitter) DOM selectors — single source of truth.
 *
 * Every CSS / data-testid selector used by any script in this skill lives
 * here. When X redeploys and a selector breaks, this is the one place to
 * update — the change propagates to all 25 tools.
 *
 * Selector confidence:
 *   - HIGH: composer textarea, tweet card, like/retweet/bookmark/reply
 *     buttons, account switcher, login username — these are stable and
 *     have v1-skill provenance plus public X-tooling community usage.
 *   - MEDIUM: profile follow/unfollow, retweet confirm sheet — pattern is
 *     stable but X has reshuffled these in the past.
 *   - LOW (verify on first failure): scheduling UI, DM composer/inbox,
 *     scheduled-tweets queue — these are inferred from observed DOM
 *     patterns and may need adjustment after first user-test.
 */

export const X_SELECTORS = {
  // ─── Composer ─────────────────────────────────────────────
  /** Main tweet textarea on home/compose. */
  tweetTextarea: '[data-testid="tweetTextarea_0"]',
  /** "Post" button in inline composer (home page). */
  tweetButtonInline: '[data-testid="tweetButtonInline"]',
  /** "Post" / "Reply" / "Schedule" button in modal composer. */
  tweetButtonModal: '[data-testid="tweetButton"]',
  /** File input for image attachments inside composer. */
  fileInput: 'input[data-testid="fileInput"], input[type="file"][accept*="image"]',
  /** Schedule (clock) icon in composer toolbar. */
  scheduleIconButton: '[data-testid="scheduleOption"]',
  /** "Confirm" button in scheduling modal. */
  scheduleConfirmButton: '[data-testid="scheduledConfirmationPrimaryAction"]',
  /** Date input in scheduling modal. */
  scheduleDateInput: 'input[type="date"], [data-testid="Date_picker_calendar_button"]',
  /** Time input in scheduling modal. */
  scheduleTimeInput: 'input[type="time"]',

  // ─── Tweet card (any list/timeline) ───────────────────────
  /** Article wrapping a single tweet. */
  tweet: 'article[data-testid="tweet"]',
  /** Tweet text content. */
  tweetText: '[data-testid="tweetText"]',
  /** Tweet author name+handle block. */
  tweetUserName: '[data-testid="User-Name"]',
  /** Tweet timestamp (anchor with the status URL + datetime). */
  tweetTime: 'time',
  /** Like button (when not yet liked). */
  like: '[data-testid="like"]',
  /** Unlike button (when already liked — same node, different testid post-state). */
  unlike: '[data-testid="unlike"]',
  /** Retweet entry button. */
  retweet: '[data-testid="retweet"]',
  /** Unretweet entry button. */
  unretweet: '[data-testid="unretweet"]',
  /** Confirm-retweet button in popup menu. */
  retweetConfirm: '[data-testid="retweetConfirm"]',
  /** Confirm-unretweet button. */
  unretweetConfirm: '[data-testid="unretweetConfirm"]',
  /** Bookmark button (not yet bookmarked). */
  bookmark: '[data-testid="bookmark"]',
  /** Remove-bookmark button (already bookmarked). */
  removeBookmark: '[data-testid="removeBookmark"]',
  /** Reply button on a tweet card. */
  reply: '[data-testid="reply"]',
  /** Generic confirmation modal "Confirm" button. */
  confirmationSheetConfirm: '[data-testid="confirmationSheetConfirm"]',
  /** Modal dialog wrapper. */
  modalDialog: '[role="dialog"][aria-modal="true"]',

  // ─── Profile ─────────────────────────────────────────────
  /** Follow button on a profile page. data-testid ends with "-follow". */
  followButton: '[data-testid$="-follow"]',
  /** Unfollow button on a profile page. data-testid ends with "-unfollow". */
  unfollowButton: '[data-testid$="-unfollow"]',
  /** Profile name / handle area. */
  userName: '[data-testid="UserName"]',

  // ─── Search ───────────────────────────────────────────────
  /** Search input on /explore. */
  searchInput: '[data-testid="SearchBox_Search_Input"]',
  /** Search results filter — "Latest" tab. */
  searchLatestTab: 'a[role="tab"][href*="f=live"]',

  // ─── Login state ──────────────────────────────────────────
  /** Side-nav account switcher button — present iff logged in. */
  accountSwitcher: '[data-testid="SideNav_AccountSwitcher_Button"]',
  /** Login form username input — present iff logged out. */
  loginUsernameInput: 'input[autocomplete="username"]',

  // ─── DMs ──────────────────────────────────────────────────
  /** Conversation row in inbox (clickable to open thread). */
  dmConversation: '[data-testid="conversation"]',
  /** "New message" button in inbox. */
  dmNewMessageButton: '[data-testid="NewDM_Button"]',
  /** Recipient input in compose-DM dialog. */
  dmComposeSearchInput: '[data-testid="searchPeople"], input[name="searchQuery"]',
  /** First search result row in compose-DM. */
  dmSearchResultUser: '[data-testid="TypeaheadUser"]',
  /** "Next" button after picking recipient(s). */
  dmComposeNextButton: '[data-testid="nextButton"]',
  /** DM message text input. */
  dmComposerTextInput: '[data-testid="dmComposerTextInput"]',
  /** Send button in DM thread. */
  dmComposerSendButton: '[data-testid="dmComposerSendButton"]',
  /** Individual message bubble in a thread. */
  dmMessageEntry: '[data-testid="messageEntry"]',

  // ─── Image alt-text on tweet media ────────────────────────
  /** Image inside tweet card. alt attribute carries alt-text or "Image". */
  tweetImage: 'img[draggable="true"][alt]',

  // ─── Tweet caret menu (used by delete-tweet) ──────────────
  /** Three-dot caret button on a tweet card that opens the action menu. */
  caret: '[data-testid="caret"]',
  /** Dropdown menu items in the caret-opened action menu. Filter by inner text in the script. */
  dropdownMenuItem: '[data-testid="Dropdown"] [role="menuitem"]',
};

/**
 * URL helpers — also single-sourced so behavior changes (e.g., x.com →
 * twitter.com fallback) only need one edit.
 */
export const X_URLS = {
  base: 'https://x.com',
  home: 'https://x.com/home',
  login: 'https://x.com/login',
  explore: 'https://x.com/explore',
  bookmarks: 'https://x.com/i/bookmarks',
  notifications: 'https://x.com/notifications',
  scheduledTweets: 'https://x.com/compose/post/unsent/scheduled',
  dmInbox: 'https://x.com/messages',
  dmCompose: 'https://x.com/messages/compose',

  /** Profile page for a handle (no leading @). */
  profile: (handle: string) => `https://x.com/${handle.replace(/^@/, '')}`,

  /** Tweet permalink. */
  tweet: (handle: string, tweetId: string) =>
    `https://x.com/${handle.replace(/^@/, '')}/status/${tweetId}`,

  /** Universal tweet permalink (handle-agnostic — X redirects). */
  tweetById: (tweetId: string) => `https://x.com/i/status/${tweetId}`,

  /** Search query URL. */
  search: (query: string, latest = false) => {
    const u = new URL('https://x.com/search');
    u.searchParams.set('q', query);
    u.searchParams.set('src', 'typed_query');
    if (latest) u.searchParams.set('f', 'live');
    return u.toString();
  },
};
