import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type StreamHandlers,
  type ToolStatusEvent,
} from '@/api/collaborator';
import type {
  ConversationTree,
  ProposedDraft,
  RecallBlock,
  ToolActivity,
  TreeNode,
} from '@/domain/models';
import { getToolsEnabled } from '@/features/settings/uiPrefs';
import { currentLocation } from '@/lib/location';
import { saveTurnSources } from './sourcesStore';
import { foldToolEvent } from './toolActivity';
import {
  removeNode,
  renameNode,
  setChatTags,
  setNodeTitle,
  setSubtreeState,
} from './treeEdits';
import {
  CONTINUE,
  VIRTUAL_ROOT,
  computePath,
  forkOf,
  indexNodes,
  mainChild,
  rootOf,
  type NodeIndex,
  type PathStep,
} from './treePath';

/** The branch switcher shown on a node that has branch children. */
export interface ForkInfo {
  parentId: number;
  /** Displayed numerator: 0 = the empty "continue here" slot, 1..n = branches. */
  current: number;
  /** Number of branch/children options (n). */
  total: number;
  /** Source paragraph of the active option (for highlight); null for empty. */
  paragraphIndex: number | null;
  /** Generated label of the line shown (selected branch or main line). */
  label: string | null;
}

export interface PathEntry extends PathStep {
  /** Switcher for this node's children (branch fork), or null. */
  fork: ForkInfo | null;
}

/** Streaming overlay shown at the bottom while a send/branch is in flight. */
export interface Streaming {
  user: string;
  reply: string;
}

/** The optimistic bubble's text for a message that is only attachments. */
/** How long a stopped reply may take to end before the connection is cut. */
export const STOP_GRACE_MS = 8000;

/** An id for one streamed reply (randomUUID needs a secure context). */
export function newStreamId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto && window.isSecureContext
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function attachedLabel(ids: number[]): string {
  return ids.length === 1 ? '📎 1 attachment' : `📎 ${ids.length} attachments`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function useConversation(reloadSignal: number) {
  const [selection, setSelection] = useState<Map<number, number>>(new Map());
  const [tree, setTree] = useState<ConversationTree>({
    roots: [],
    count: 0,
    contextWindow: null,
  });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  // The LIVE recall block during a send (shown in the streaming overlay). Once the
  // turn commits, the persisted block comes back from the tree (node.recall).
  const [recall, setRecall] = useState<RecallBlock | null>(null);
  // Display-only chain-of-thought for the in-flight reply (545e1a5). Never
  // part of the transcript — discarded when the stream settles.
  const [reasoning, setReasoning] = useState('');
  // The finished reply's reasoning stays on show under it until the next
  // send (as in a call, until the mic reopens). Still display-only: never
  // saved, gone on reload.
  const [lastThought, setLastThought] = useState<{ id: number; text: string } | null>(null);
  const reasoningRef = useRef('');
  // Live tool activity feed for the in-flight turn: a row per tool call,
  // resolved in place by its outcome event. Cleared each turn.
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  // Drafts the model proposed this turn (pending in the inbox). Kept after
  // the stream so the chat can offer a "review" link; cleared on the next
  // send or when the user follows the link.
  const [proposedDrafts, setProposedDrafts] = useState<ProposedDraft[]>([]);
  // Links the model wanted to read but couldn't (per-turn fetch budget hit).
  // Kept after the stream for one-tap follow-ups; a new send clears them
  // (each user message starts a fresh budget).
  const [unfollowedLinks, setUnfollowedLinks] = useState<string[]>([]);
  // Index kept in a ref so it's fresh synchronously after a load (selectPathTo
  // runs right after) while still triggering re-render via the `version` bump.
  const indexRef = useRef<NodeIndex>(
    indexNodes({ roots: [], count: 0, contextWindow: null }),
  );
  // Latest applied tree — input for optimistic local edits (treeEdits.ts).
  const treeRef = useRef<ConversationTree>({
    roots: [],
    count: 0,
    contextWindow: null,
  });
  const [version, setVersion] = useState(0);
  const leafRef = useRef<number | null>(null);
  // Abort controller for the in-flight send/branch stream (the fallback
  // when a stop request can't get through).
  const abortRef = useRef<AbortController | null>(null);
  // The in-flight stream's id (api.stopStream) and whether it's been stopped:
  // once stopped, the reply on screen freezes where it was.
  const streamIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  // Swap in a fresh tree synchronously so callers can batch further state
  // updates (e.g. clearing the streaming overlay) into the same render.
  // Mirror of `activity` readable after the stream settles (state clears in
  // the finally block, but the sources cache wants the final feed).
  const activityRef = useRef<ToolActivity[]>([]);
  const applyToolEvent = useCallback((e: ToolStatusEvent) => {
    setActivity((prev) => {
      const next = foldToolEvent(prev, e);
      activityRef.current = next;
      return next;
    });
  }, []);

  const applyTree = useCallback((t: ConversationTree) => {
    indexRef.current = indexNodes(t);
    treeRef.current = t; // latest tree for optimistic edits, no dep churn
    setTree(t);
    if (t.contextWindow != null) setContextWindow(t.contextWindow);
    setVersion((v) => v + 1);
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      applyTree(await api.getTree());
    } catch (err) {
      setError(errMessage(err));
      setLoading(false);
    }
  }, [applyTree]);

  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  /**
   * Background confirm for an optimistic mutation (treeEdits.ts prediction
   * already applied): true-up silently on success; on failure resync from
   * the server — the source of truth — and surface the error. No rollback
   * bookkeeping, so concurrent optimistic ops can't clobber each other.
   */
  const confirmMutation = useCallback(
    (op: Promise<unknown>) => {
      op.then(
        () => load(),
        async (err: unknown) => {
          await load().catch(() => {});
          setError(errMessage(err));
        },
      );
    },
    [load],
  );

  /**
   * Enter "new chat" mode: empty path, so the next send omits parent_turn_id
   * and creates a fresh root (a seed, per the backend default). Implemented as
   * the CONTINUE sentinel at the virtual root — once the send completes,
   * selectPathTo(new id) replaces this selection with the new conversation.
   */
  const startNewChat = useCallback(() => {
    setError(null); // errors belong to the conversation they happened in
    setSelection(new Map([[VIRTUAL_ROOT, CONTINUE]]));
  }, []);

  /** The root of the conversation containing `turnId` (per the current tree). */
  const rootOfTurn = useCallback((turnId: number): TreeNode | null => {
    const { parentOf, byId } = indexRef.current;
    return byId.get(rootOf(parentOf, turnId)) ?? null;
  }, []);

  // Point the active path at a specific turn: build a FRESH selection with only
  // the ancestry to it, so everything below (and any prior off-path picks) reverts
  // to the default main line. Uses the nesting-derived parent map.
  const selectPathTo = useCallback((turnId: number) => {
    setError(null); // errors belong to the conversation they happened in
    const { parentOf } = indexRef.current;
    const next = new Map<number, number>();
    let child = turnId;
    let parent = parentOf.get(turnId);
    while (parent !== undefined) {
      next.set(parent, child);
      if (parent === VIRTUAL_ROOT) break;
      child = parent;
      parent = parentOf.get(parent);
    }
    setSelection(next);
  }, []);

  /**
   * Run a streamed send/branch. 'ok' = completed; 'stopped' = the user
   * aborted (partial exchange kept server-side); 'failed' = error. Callers
   * restore the composer draft for anything but 'ok' — a stopped reply
   * usually means the message needs a tweak before resending.
   */
  const runStream = useCallback(
    async (
      userText: string,
      stream: (
        handlers: StreamHandlers,
        signal: AbortSignal,
        streamId: string,
      ) => Promise<{
        id: number | null;
        contextWindow: number | null;
      }>,
    ): Promise<'ok' | 'stopped' | 'failed'> => {
      const abort = new AbortController();
      abortRef.current = abort;
      const streamId = newStreamId();
      streamIdRef.current = streamId;
      stoppingRef.current = false;
      setStopping(false);
      setSending(true);
      setError(null);
      setRecall(null);
      setReasoning('');
      reasoningRef.current = '';
      setLastThought(null);
      setActivity([]);
      activityRef.current = [];
      setProposedDrafts([]);
      setUnfollowedLinks([]);
      setStreaming({ user: userText, reply: '' });
      try {
        const res = await stream(
          {
            onToken: (c) => {
              if (stoppingRef.current) return; // stopped: the reply stays as shown
              setStreaming((s) => (s ? { ...s, reply: s.reply + c } : s));
            },
            onRecall: (block) => setRecall(block),
            onReasoning: (c) => {
              reasoningRef.current += c;
              setReasoning((prev) => prev + c);
            },
            onStatus: applyToolEvent,
            onDrafts: (drafts) =>
              setProposedDrafts((prev) => [...prev, ...drafts]),
            onUnfollowedLinks: (links) => setUnfollowedLinks(links),
          },
          abort.signal,
          streamId,
        );
        // Fetch first, THEN apply + clear the overlay in one synchronous block
        // (single render) — an await between the two briefly shows the new
        // turns and the overlay copy together.
        const t = await api.getTree();
        applyTree(t);
        if (res.id != null) {
          selectPathTo(res.id);
          if (reasoningRef.current) {
            setLastThought({ id: res.id, text: reasoningRef.current });
          }
          // Cache the tool feed for this turn — fallback for turns whose
          // persisted `tools` haven't been fetched yet this session.
          saveTurnSources(res.id, activityRef.current);
        }
        if (res.contextWindow != null) setContextWindow(res.contextWindow);
        return 'ok';
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // The stop request couldn't get through, so the connection was cut;
          // the backend saves what it had on its side. Sync, no error.
          try {
            applyTree(await api.getTree());
          } catch {
            /* offline — the next load will catch up */
          }
          return 'stopped';
        }
        setError(errMessage(err));
        return 'failed';
      } finally {
        abortRef.current = null;
        streamIdRef.current = null;
        stoppingRef.current = false;
        setStopping(false);
        setSending(false);
        setStreaming(null);
        setActivity([]);
        // Persisted recall now comes from the tree (node.recall) on reload.
        setRecall(null);
        setReasoning(''); // display-only — never survives the stream
      }
    },
    [applyTree, selectPathTo, applyToolEvent],
  );

  /**
   * Stop the in-flight reply. It freezes on screen at once; the backend ends
   * the model call, saves the exchange so far and closes the stream normally,
   * so the turn stays (it doesn't vanish and come back). If the stop request
   * fails or the stream doesn't end soon, the connection is cut instead (the
   * backend saves on that too).
   */
  const stopGeneration = useCallback(() => {
    const id = streamIdRef.current;
    const abort = abortRef.current;
    if (!id || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    void api.stopStream(id).catch(() => abort?.abort());
    setTimeout(() => {
      if (streamIdRef.current === id) abort?.abort();
    }, STOP_GRACE_MS);
  }, []);

  const clearProposedDrafts = useCallback(() => setProposedDrafts([]), []);

  const send = useCallback(
    async (message: string, attachmentIds: number[] = []): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed && attachmentIds.length === 0) return true;
      const outcome = await runStream(trimmed || attachedLabel(attachmentIds), async (handlers, signal, streamId) =>
        api.sendMessageStream(
          // Active leaf to continue from (omit for a brand-new conversation).
          {
            message: trimmed,
            parentTurnId: leafRef.current ?? undefined,
            tools: getToolsEnabled(),
            location: await currentLocation(),
            attachmentIds,
            streamId,
          },
          handlers,
          signal,
        ),
      );
      // false restores the composer draft (the send failed). A stopped reply
      // is kept, so the message isn't handed back.
      return outcome === 'ok';
    },
    [runStream],
  );

  /**
   * Promote a conversation (call with its root id): seed → tree.
   * Optimistic — the root hops tabs immediately.
   */
  const promote = useCallback(
    (rootId: number) => {
      setError(null);
      applyTree(setSubtreeState(treeRef.current, rootId, 'tree'));
      confirmMutation(api.setTurnState(rootId, 'tree'));
    },
    [applyTree, confirmMutation],
  );

  const branch = useCallback(
    async (
      parentTurnId: number,
      message: string,
      paragraphIndex?: number,
      attachmentIds: number[] = [],
    ): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed && attachmentIds.length === 0) return true;
      // Branching is a graduation signal: capture the seed root BEFORE the
      // stream (the reload inside runStream rebuilds the index).
      const root = rootOfTurn(parentTurnId);
      const seedRootId = root?.state === 'seed' ? root.id : null;
      const outcome = await runStream(trimmed || attachedLabel(attachmentIds), async (handlers, signal, streamId) =>
        api.branchMessage(
          {
            parentTurnId,
            message: trimmed,
            paragraphIndex,
            tools: getToolsEnabled(),
            location: await currentLocation(),
            attachmentIds,
            streamId,
          },
          handlers,
          signal,
        ),
      );
      // A stopped branch still exists server-side → the graduation stands.
      if (outcome !== 'failed' && seedRootId != null) await promote(seedRootId);
      return outcome === 'ok';
    },
    [runStream, rootOfTurn, promote],
  );

  /**
   * Regenerate / edit-and-resend a leaf exchange: delete the assistant reply
   * and its user turn, then resend `message` (possibly edited) from the same
   * spot. Topology-aware so the exchange keeps its character:
   *   - branch roots are resent via /api/branches (same paragraph, and
   *     contextTurns:0 for without-context branches),
   *   - re-created conversation roots inherit the old state (no tree → seed
   *     demotion) and get their name restored.
   * DESTRUCTIVE by design (the old reply leaves the tree and recall) — the
   * UI must only offer it on a leaf exchange.
   */
  const editResend = useCallback(
    async (assistantId: number, message: string, addedIds: number[] = []): Promise<boolean> => {
      const trimmed = message.trim();
      const { byId, parentOf } = indexRef.current;
      const a = byId.get(assistantId);
      const uId = parentOf.get(assistantId);
      const u = uId != null && uId !== VIRTUAL_ROOT ? byId.get(uId) : undefined;
      // Regenerating keeps the files the original message carried.
      const attachmentIds = [
        ...new Set([...(u?.attachments ?? []).map((x) => x.id), ...addedIds]),
      ];
      if (!trimmed && attachmentIds.length === 0) return true;
      if (!a || !u) {
        setError('That exchange no longer exists — reload and try again.');
        return false;
      }
      // Leaf-exchange guard (belt and braces with the UI-side check).
      if (a.children.length > 0 || u.children.length !== 1) {
        setError('Only the last exchange can be regenerated.');
        return false;
      }
      const parentId = parentOf.get(u.id); // VIRTUAL_ROOT for conversation roots
      const isRoot = parentId === VIRTUAL_ROOT;
      const keepName = isRoot ? u.name : null; // only a chat (root) is named
      const keepState = isRoot ? u.state : null;
      const keepChatTags = isRoot ? u.chatTags : [];

      setError(null);
      try {
        await api.deleteTurn(a.id, true); // the reply (leaf — no descendants)
        await api.deleteTurn(u.id); // the user turn, now childless
      } catch (err) {
        setError(errMessage(err));
        return false;
      }

      const outcome = await runStream(trimmed || attachedLabel(attachmentIds), async (handlers, signal, streamId) =>
        u.branched && parentId != null && parentId !== VIRTUAL_ROOT
          ? api.branchMessage(
              {
                parentTurnId: parentId,
                message: trimmed,
                paragraphIndex: u.paragraphIndex ?? undefined,
                tools: getToolsEnabled(),
                location: await currentLocation(),
                attachmentIds,
                streamId,
              },
              handlers,
              signal,
            )
          : api.sendMessageStream(
              {
                message: trimmed,
                parentTurnId: isRoot ? undefined : (parentId ?? undefined),
                tools: getToolsEnabled(),
                location: await currentLocation(),
                attachmentIds,
                streamId,
                ...(keepState ? { state: keepState } : {}),
              },
              handlers,
              signal,
            ),
      );

      // Restore the name (and a root's chat tags) onto the re-created
      // root/branch-root (the new user turn = parent of the streamed
      // assistant turn in the fresh index). Runs on 'stopped' too — the
      // partial exchange was persisted. Both were set on the old root, so
      // the chat was already promoted; restoring them changes nothing else.
      const restore = keepName || keepChatTags.length > 0;
      if (outcome !== 'failed' && restore && leafRef.current != null) {
        const fresh = indexRef.current;
        const newUserId = fresh.parentOf.get(leafRef.current);
        if (newUserId != null && newUserId !== VIRTUAL_ROOT) {
          try {
            // Direct calls (not renameTurn) — no optimistic local edits.
            if (keepName) await api.renameTurn(newUserId, keepName);
            if (keepChatTags.length > 0) {
              await api.setChatTags(newUserId, keepChatTags);
            }
            await load();
          } catch {
            /* restore is best-effort */
          }
        }
      }
      return outcome === 'ok';
    },
    [runStream, load],
  );

  /** Optimistic delete — the node vanishes immediately (subtree or reparent). */
  const remove = useCallback(
    (turnId: number, subtree = false) => {
      setError(null);
      applyTree(removeNode(treeRef.current, turnId, subtree));
      confirmMutation(api.deleteTurn(turnId, subtree));
    },
    [applyTree, confirmMutation],
  );

  /** Optimistic rename; naming a seed also graduates it (both local-first). */
  const renameTurn = useCallback(
    (turnId: number, name: string) => {
      setError(null);
      // Naming a seed is a "this matters" signal — it graduates the chat.
      const root = rootOfTurn(turnId);
      const promoteId =
        name.trim() && root?.state === 'seed' ? root.id : null;
      let next = renameNode(treeRef.current, turnId, name);
      if (promoteId != null) next = setSubtreeState(next, promoteId, 'tree');
      applyTree(next);
      confirmMutation(
        (async () => {
          await api.renameTurn(turnId, name);
          if (promoteId != null) await api.setTurnState(promoteId, 'tree');
        })(),
      );
    },
    [applyTree, confirmMutation, rootOfTurn],
  );

  // Cycle a node's branch switcher: 0 = main line, 1..n = branches.
  const cycleFork = useCallback((parentId: number, dir: 1 | -1) => {
    setSelection((prev) => {
      const children = indexRef.current.childrenOf.get(parentId) ?? [];
      const branches = children.filter((c) => c.branched);
      if (branches.length === 0) return prev;
      const f = forkOf(children, prev.get(parentId));
      const positions = branches.length + 1; // 0 (main) + each branch
      const nextPos = ((f?.current ?? 0) + dir + positions) % positions;
      const next = new Map(prev);
      if (nextPos === 0) {
        const cont = mainChild(children);
        next.set(parentId, cont ? cont.id : CONTINUE); // main line (or stop)
      } else {
        next.set(parentId, branches[nextPos - 1].id);
      }
      return next;
    });
  }, []);

  // Recomputed only when the tree (version) or selection changes — TreeMap
  // and ChatView get referentially stable values between those changes.
  const { path, activeIds, activeLeafId } = useMemo(() => {
    const steps = computePath(indexRef.current.childrenOf, selection);
    const path: PathEntry[] = steps.map((s) => {
      const children = indexRef.current.childrenOf.get(s.node.id) ?? [];
      const f = forkOf(children, selection.get(s.node.id));
      const fork: ForkInfo | null = f
        ? {
            parentId: s.node.id,
            current: f.current,
            total: f.total,
            paragraphIndex: f.paragraphIndex,
            label: f.label,
          }
        : null;
      return { ...s, fork };
    });
    const activeIds = new Set(path.map((e) => e.node.id));
    const activeLeafId = path.length ? path[path.length - 1].node.id : null;
    return { path, activeIds, activeLeafId };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, selection]);
  // Kept in a ref so `send` (a stable callback) always reads the current leaf.
  leafRef.current = activeLeafId;

  return {
    path,
    tree,
    activeIds,
    activeLeafId,
    loading,
    sending,
    error,
    contextWindow,
    streaming,
    recall,
    reasoning,
    lastThought,
    activity,
    proposedDrafts,
    clearProposedDrafts,
    unfollowedLinks,
    send,
    branch,
    editResend,
    stopGeneration,
    stopping,
    cycleFork,
    selectPathTo,
    startNewChat,
    rootOfTurn,
    promote,
    remove,
    renameTurn,
    reload: load,
    clearError: useCallback(() => setError(null), []),
    /**
     * Apply a chat's saved tags locally (the PUT response is the truth).
     * Tagging promotes a seed server-side; mirror it so the chat moves lists.
     */
    setChatTagsLocal: useCallback(
      (rootId: number, tags: string[]) => {
        let next = setChatTags(treeRef.current, rootId, tags);
        if (tags.length > 0) next = setSubtreeState(next, rootId, 'tree');
        applyTree(next);
      },
      [applyTree],
    ),
    /** Apply a regenerated LLM title locally (response = source of truth). */
    setTitleLocal: useCallback(
      (rootId: number, title: string) =>
        applyTree(setNodeTitle(treeRef.current, rootId, title)),
      [applyTree],
    ),
  };
}

/** Everything the conversation screens share (lifted to the app shell). */
export type Conversation = ReturnType<typeof useConversation>;
