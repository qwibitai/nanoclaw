import { describe, it, expect } from 'vitest';

import { looksLikeExpectingFollowUp } from './smart-batch.js';

describe('looksLikeExpectingFollowUp', () => {
  describe('matches messages expecting a follow-up', () => {
    const positives = [
      'read this article',
      'Read this article',
      'check this out',
      'Check it out',
      'look at this',
      'watch this video',
      'listen to this',
      "here's a link",
      'here is the article',
      'take a look',
      'sent you a link',
      'just sent the article',
      'I just sent you this',
      'the article is interesting',
      'this post is great',
      'this video is hilarious',
      'the thread about AI',
      'this tweet is wild',
      'check the page',
      'read the post',
      'this reel is funny',
    ];

    for (const msg of positives) {
      it(`matches: "${msg}"`, () => {
        expect(looksLikeExpectingFollowUp(msg)).toBe(true);
      });
    }
  });

  describe('does not match normal messages', () => {
    const negatives = [
      'how are you',
      'set a timer for 5 minutes',
      'what time is it',
      'hello',
      'remind me to buy groceries',
      'play some music',
      'turn off the lights',
      'good morning',
    ];

    for (const msg of negatives) {
      it(`does not match: "${msg}"`, () => {
        expect(looksLikeExpectingFollowUp(msg)).toBe(false);
      });
    }
  });

  describe('does not match messages that already contain a URL', () => {
    const withUrls = [
      'read this article https://example.com/post',
      'check this out http://foo.bar',
      'here is the link https://news.ycombinator.com/item?id=123',
    ];

    for (const msg of withUrls) {
      it(`skips URL-containing: "${msg}"`, () => {
        expect(looksLikeExpectingFollowUp(msg)).toBe(false);
      });
    }
  });
});
