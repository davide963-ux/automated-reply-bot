export interface XTweet {
  id: string;
  conversationId: string;
  authorId: string;
  authorUsername?: string;
  text: string;
  createdAt: Date | null;
  inReplyToUserId?: string;
  /** ids this tweet replies to / quotes / retweets */
  referenced: Array<{ type: string; id: string }>;
}

/**
 * Result of a publish call. The distinction matters for the daily-limit gate:
 *  - created : X confirmed the post exists
 *  - rejected: X answered with a 4xx, so NOTHING was created (safe to release the slot)
 *  - unknown : timeout / 5xx / garbled reply, the post MAY exist (keep the slot, reconcile)
 */
export type PublishOutcome =
  | { kind: 'created'; id: string }
  | { kind: 'rejected'; status: number; reason: string; duplicate: boolean; authFailure: boolean }
  | { kind: 'unknown'; reason: string };

export interface XApi {
  me(): Promise<{ id: string; username: string }>;
  createPost(text: string, replyToId?: string): Promise<PublishOutcome>;
  getMentions(userId: string, sinceId?: string): Promise<XTweet[]>;
  searchRecent(q: string, sinceId?: string): Promise<XTweet[]>;
  getUserTweets(userId: string, sinceId?: string): Promise<XTweet[]>;
  resolveUsername(username: string): Promise<{ id: string; username: string } | null>;
  /** Our own latest tweets (posts and replies), used to reconcile UNCERTAIN publishes. */
  getOwnRecentTweets(userId: string): Promise<XTweet[]>;
}

export class XAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XAuthError';
  }
}

export class XRateLimitError extends Error {
  constructor(public readonly resetAt: Date) {
    super(`X rate limited until ${resetAt.toISOString()}`);
    this.name = 'XRateLimitError';
  }
}

export class XBudgetError extends Error {
  constructor() {
    super('daily X spend cap reached, skipping non-essential X calls');
    this.name = 'XBudgetError';
  }
}
