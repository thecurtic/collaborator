import type { TurnAttachment } from '@/domain/models';

/**
 * What a call does before its first listen:
 * - 'send': the composer draft is submitted as the first spoken turn — the
 *   reply streams and speaks, then the call continues normally. Files lined
 *   up in the composer go with it; files alone are sent as they are, with no
 *   words added, and the call opens on the reply.
 * - 'speak': an existing assistant reply is read aloud first, then the call
 *   listens. Combined with a BranchTarget when the reply isn't the tip, so
 *   the first spoken turn forks from it.
 */
export type CallIntro =
  | { kind: 'send'; text: string; attachments?: TurnAttachment[] }
  | { kind: 'speak'; text: string };
