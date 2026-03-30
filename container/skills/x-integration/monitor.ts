// container/skills/x-integration/monitor.ts
import type {
  SocialMonitor,
  MonitorContext,
  TimelineItem,
  EngagementAction,
  ActionResult,
  PersonaDraft,
} from '../social-monitor/interfaces.js';
import {
  postTweet,
  replyToTweet,
  quoteTweet,
  likeTweet,
  retweet,
  getHomeTimeline,
  getUserTweets,
  getLikedTweets,
} from './actions.js';

export class XMonitor implements SocialMonitor {
  platform = 'x';

  async fetchTimeline(ctx: MonitorContext): Promise<TimelineItem[]> {
    const response = await getHomeTimeline(50) as any;
    const tweets = response.data ?? [];
    const users = new Map<string, any>();
    for (const user of response.includes?.users ?? []) {
      users.set(user.id, user);
    }

    return tweets.map((tweet: any) => {
      const author = users.get(tweet.author_id);
      return {
        id: tweet.id,
        author: {
          handle: author?.username ?? 'unknown',
          name: author?.name ?? 'Unknown',
          followers: author?.public_metrics?.followers_count,
        },
        content: tweet.text,
        createdAt: tweet.created_at,
        metrics: tweet.public_metrics
          ? {
              likes: tweet.public_metrics.like_count,
              replies: tweet.public_metrics.reply_count,
              reposts: tweet.public_metrics.retweet_count,
            }
          : undefined,
        url: `https://x.com/${author?.username ?? 'i'}/status/${tweet.id}`,
      };
    });
  }

  formatForDecision(items: TimelineItem[]): string {
    return items
      .map((item, i) => {
        const metrics = item.metrics
          ? ` [${item.metrics.likes}L ${item.metrics.replies}R ${item.metrics.reposts}RT]`
          : '';
        return `[${i}] @${item.author.handle}${item.author.followers ? ` (${item.author.followers} followers)` : ''}${metrics}\n    ${item.content}\n    ${item.url}`;
      })
      .join('\n\n');
  }

  async executeAction(action: EngagementAction): Promise<ActionResult> {
    switch (action.type) {
      case 'like':
        return likeTweet(action.targetId);
      case 'reply':
        if (!action.content) return { success: false, error: 'Reply requires content' };
        return replyToTweet(action.targetId, action.content);
      case 'repost':
        return retweet(action.targetId);
      case 'quote':
        if (!action.content) return { success: false, error: 'Quote requires content' };
        return quoteTweet(action.targetId, action.content);
      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }

  async bootstrapPersona(ctx: MonitorContext): Promise<PersonaDraft> {
    const [tweetsResp, likesResp] = await Promise.all([
      getUserTweets(200) as Promise<any>,
      getLikedTweets(100) as Promise<any>,
    ]);

    const tweets = tweetsResp.data ?? [];
    const likes = likesResp.data ?? [];

    const tweetDates = tweets.map((t: any) => t.created_at).filter(Boolean).sort();
    const dateRange = {
      from: tweetDates[0] ?? new Date().toISOString(),
      to: tweetDates[tweetDates.length - 1] ?? new Date().toISOString(),
    };

    const tweetSummary = tweets
      .slice(0, 50)
      .map((t: any, i: number) => `[${i}] ${t.text}`)
      .join('\n');

    const likeSummary = likes
      .slice(0, 30)
      .map((t: any, i: number) => `[${i}] ${t.text}`)
      .join('\n');

    const analysisPrompt = `Analyze this X/Twitter account's recent activity and generate an x-persona.md file.

<recent_tweets count="${tweets.length}">
${tweetSummary}
</recent_tweets>

<recent_likes count="${likes.length}">
${likeSummary}
</recent_likes>

Generate an x-persona.md following this template exactly:

# X Persona

## Identity
(Describe the account's voice, tone, and role based on their tweets)

## Engage Rules
### Always Engage
- @handles: (accounts they interact with most)
- Topics: (recurring themes in their tweets and likes)

### Never Engage
- Topics: (topics they clearly avoid)
- Accounts: (types of accounts they don't engage with)

### Style
- Replies: (describe their reply style based on their tweets)
- Likes: (describe what they tend to like)
- Quotes: (describe when they quote tweet)

## Content Guidelines
- Voice: (describe their writing voice)
- Promote: (what they promote or share)
- Avoid: (what they avoid posting about)

## Goals
- (Inferred goals based on their activity patterns)

Be specific and grounded in the actual data. Don't make up details that aren't supported by the tweets and likes.`;

    return {
      content: analysisPrompt,
      sourceStats: {
        postsAnalyzed: tweets.length,
        likesAnalyzed: likes.length,
        dateRange,
      },
    };
  }
}
