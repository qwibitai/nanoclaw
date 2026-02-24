const URL_RE = /https?:\/\//i;

const EXPECTING_FOLLOWUP_PATTERNS = [
  // "read/check/look at/watch/listen to this/that/the ..."
  /\b(?:read|check|look\s+at|watch|listen\s+to)\s+(?:this|that|the)\b/i,
  // "this/the article/link/video/post/tweet/page/thread/reel/site/song/podcast/story"
  /\b(?:this|the)\s+(?:article|link|video|post|tweet|page|thread|reel|site|song|podcast|story|url)\b/i,
  // "sent you a/the/this", "just sent"
  /\b(?:just\s+)?sent\s+(?:you\s+)?(?:a|the|this)\b/i,
  // "here's a/the", "here is a/the"
  /\bhere(?:'s|\s+is)\s+(?:a|the|an)\b/i,
  // "take a look", "check this out", "check it out"
  /\btake\s+a\s+look\b/i,
  /\bcheck\s+(?:this|it)\s+out\b/i,
];

/**
 * Returns true if the message text looks like it expects a follow-up
 * (e.g. a URL) but doesn't already contain one.
 */
export function looksLikeExpectingFollowUp(content: string): boolean {
  if (URL_RE.test(content)) return false;
  return EXPECTING_FOLLOWUP_PATTERNS.some((re) => re.test(content));
}
