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
import { saveTurnSources } from './sourcesStore';
import { foldToolEvent } from './toolActivity';
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
  /** The selected branch's own name (its branch-root turn), if any. */
  name: string | null;
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
  const [version, setVersion] = useState(0);
  const leafRef = useRef<number | null>(null);
  // Abort controller for the in-flight send/branch stream (stop generation).
  const abortRef = useRef<AbortController | null>(null);

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
   * Enter "new chat" mode: empty path, so the next send omits parent_turn_id
   * and creates a fresh root (a seed, per the backend default). Implemented as
   * the CONTINUE sentinel at the virtual root — once the send completes,
   * selectPathTo(new id) replaces this selection with the new conversation.
   */
  const startNewChat = useCallback(() => {
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
   * Run a streamed send/branch. Resolves true on success (or a deliberate
   * stop), false on failure — so the composer can restore the lost draft.
   */
  const runStream = useCallback(
    async (
      userText: string,
      stream: (
        handlers: StreamHandlers,
        signal: AbortSignal,
      ) => Promise<{
        id: number | null;
        contextWindow: number | null;
      }>,
    ): Promise<boolean> => {
      const abort = new AbortController();
      abortRef.current = abort;
      setSending(true);
      setError(null);
      setRecall(null);
      setActivity([]);
      activityRef.current = [];
      setProposedDrafts([]);
      setUnfollowedLinks([]);
      setStreaming({ user: userText, reply: '' });
      try {
        const res = await stream(
          {
            onToken: (c) =>
              setStreaming((s) => (s ? { ...s, reply: s.reply + c } : s)),
            onRecall: (block) => setRecall(block),
            onStatus: applyToolEvent,
            onDrafts: (drafts) =>
              setProposedDrafts((prev) => [...prev, ...drafts]),
            onUnfollowedLinks: (links) => setUnfollowedLinks(links),
          },
          abort.signal,
        );
        // Fetch first, THEN apply + clear the overlay in one synchronous block
        // (single render) — an await between the two briefly shows the new
        // turns and the overlay copy together.
        const t = await api.getTree();
        applyTree(t);
        if (res.id != null) {
          selectPathTo(res.id);
          // Cache the tool feed for this turn — fallback for turns whose
          // persisted `tools` haven't been fetched yet this session.
          saveTurnSources(res.id, activityRef.current);
        }
        if (res.contextWindow != null) setContextWindow(res.contextWindow);
        return true;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Deliberate stop: sync whatever the backend persisted, no error.
          try {
            applyTree(await api.getTree());
          } catch {
            /* offline — the next load will catch up */
          }
          return true;
        }
        setError(errMessage(err));
        return false;
      } finally {
        abortRef.current = null;
        setSending(false);
        setStreaming(null);
        setActivity([]);
        // Persisted recall now comes from the tree (node.recall) on reload.
        setRecall(null);
      }
    },
    [applyTree, selectPathTo, applyToolEvent],
  );

  /** Abort the in-flight send/branch stream (the reply so far is kept server-side). */
  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearProposedDrafts = useCallback(() => setProposedDrafts([]), []);

  const send = useCallback(
    (message: string): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed) return Promise.resolve(true);
      return runStream(trimmed, (handlers, signal) =>
        api.sendMessageStream(
          // Active leaf to continue from (omit for a brand-new conversation).
          {
            message: trimmed,
            parentTurnId: leafRef.current ?? undefined,
            tools: getToolsEnabled(),
          },
          handlers,
          signal,
        ),
      );
    },
    [runStream],
  );

  /** Promote a conversation (call with its root id): seed → tree. */
  const promote = useCallback(
    async (rootId: number) => {
      setError(null);
      try {
        await api.setTurnState(rootId, 'tree');
        await load();
      } catch (err) {
        setError(errMessage(err));
      }
    },
    [load],
  );

  const branch = useCallback(
    async (
      parentTurnId: number,
      message: string,
      paragraphIndex?: number,
      withContext = true,
    ): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed) return true;
      // Branching is a graduation signal: capture the seed root BEFORE the
      // stream (the reload inside runStream rebuilds the index).
      const root = rootOfTurn(parentTurnId);
      const seedRootId = root?.state === 'seed' ? root.id : null;
      const ok = await runStream(trimmed, (handlers, signal) =>
        api.branchMessage(
          {
            parentTurnId,
            message: trimmed,
            paragraphIndex,
            tools: getToolsEnabled(),
            // "Without context" → fresh branch, no prior turns injected.
            ...(withContext ? {} : { contextTurns: 0 }),
          },
          handlers,
          signal,
        ),
      );
      if (ok && seedRootId != null) await promote(seedRootId);
      return ok;
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
    async (assistantId: number, message: string): Promise<boolean> => {
      const trimmed = message.trim();
      if (!trimmed) return true;
      const { byId, parentOf } = indexRef.current;
      const a = byId.get(assistantId);
      const uId = parentOf.get(assistantId);
      const u = uId != null && uId !== VIRTUAL_ROOT ? byId.get(uId) : undefined;
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
      const keepName = u.name; // conversation name (root) or branch name
      const keepState = isRoot ? u.state : null;

      setError(null);
      try {
        await api.deleteTurn(a.id, true); // the reply (leaf — no descendants)
        await api.deleteTurn(u.id); // the user turn, now childless
      } catch (err) {
        setError(errMessage(err));
        return false;
      }

      const ok = await runStream(trimmed, (handlers, signal) =>
        u.branched && parentId != null && parentId !== VIRTUAL_ROOT
          ? api.branchMessage(
              {
                parentTurnId: parentId,
                message: trimmed,
                paragraphIndex: u.paragraphIndex ?? undefined,
                tools: getToolsEnabled(),
                ...(u.contextBoundary ? { contextTurns: 0 } : {}),
              },
              handlers,
              signal,
            )
          : api.sendMessageStream(
              {
                message: trimmed,
                parentTurnId: isRoot ? undefined : (parentId ?? undefined),
                tools: getToolsEnabled(),
                ...(keepState ? { state: keepState } : {}),
              },
              handlers,
              signal,
            ),
      );

      // Restore the name onto the re-created root/branch-root (the new user
      // turn = parent of the streamed assistant turn in the fresh index).
      if (ok && keepName && leafRef.current != null) {
        const fresh = indexRef.current;
        const newUserId = fresh.parentOf.get(leafRef.current);
        if (newUserId != null && newUserId !== VIRTUAL_ROOT) {
          try {
            // Direct call (not renameTurn) — must not trigger seed promotion.
            await api.renameTurn(newUserId, keepName);
            await load();
          } catch {
            /* name restore is best-effort */
          }
        }
      }
      return ok;
    },
    [runStream, load],
  );

  const remove = useCallback(
    async (turnId: number, subtree = false) => {
      setError(null);
      try {
        await api.deleteTurn(turnId, subtree);
        await load();
      } catch (err) {
        setError(errMessage(err));
      }
    },
    [load],
  );

  const renameTurn = useCallback(
    async (turnId: number, name: string) => {
      setError(null);
      try {
        await api.renameTurn(turnId, name);
        // Naming a seed is a "this matters" signal — it graduates the chat.
        const root = rootOfTurn(turnId);
        if (name.trim() && root?.state === 'seed') {
          await api.setTurnState(root.id, 'tree');
        }
        await load();
      } catch (err) {
        setError(errMessage(err));
      }
    },
    [load, rootOfTurn],
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
            name: f.name,
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
    activity,
    proposedDrafts,
    clearProposedDrafts,
    unfollowedLinks,
    send,
    branch,
    editResend,
    stopGeneration,
    cycleFork,
    selectPathTo,
    startNewChat,
    rootOfTurn,
    promote,
    remove,
    renameTurn,
    reload: load,
  };
}

/** Everything the conversation screens share (lifted to the app shell). */
export type Conversation = ReturnType<typeof useConversation>;
