import type { TurnAttachment } from '@/domain/models';

/**
 * What a call does before its first listen:
 * - 'send': the composer draft is submitted as the first spoken turn — the
 *   reply streams and speaks, then the call continues normally. Files lined
 *   up in the composer come along as a hand-over: with the draft when there
 *   is one, else with the first thing said (the call listens first).
 * - 'speak': an existing assistant reply is read aloud first, then the call
 *   listens. Combined with a BranchTarget when the reply isn't the tip, so
 *   the first spoken turn forks from it.
 */
export type CallIntro =
  | { kind: 'send'; text: string; attachments?: TurnAttachment[] }
  | { kind: 'speak'; text: string };
