import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import type { ConversationTree, RecallBlock, TreeNode } from '@/domain/models';
import { getRecallEnabled } from '@/features/settings/uiPrefs';

const VIRTUAL_ROOT = 0;
// Selection sentinel: "no branch chosen here — stop and continue from this turn".
const CONTINUE = -1;

/** The branch switcher shown on a node that has branch children. */
export interface ForkInfo {
  parentId: number;
  /** Displayed numerator: 0 = the empty "continue here" slot, 1..n = branches. */
  current: number;
  /** Number of branch/children options (n). */
  total: number;
  /** Source paragraph of the active option (for highlight); null for empty. */
  paragraphIndex: number | null;
}

interface PathStep {
  node: TreeNode;
  /** All children at this level (siblings of `node`) — for the root switcher. */
  siblings: TreeNode[];
  /** Parent id (VIRTUAL_ROOT for top-level). Keys the selection map. */
  parentId: number;
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

interface NodeIndex {
  byId: Map<number, TreeNode>;
  childrenOf: Map<number, TreeNode[]>;
  /** child id → parent id (VIRTUAL_ROOT for roots), derived from the nesting. */
  parentOf: Map<number, number>;
}

function indexNodes(tree: ConversationTree): NodeIndex {
  const byId = new Map<number, TreeNode>();
  const childrenOf = new Map<number, TreeNode[]>();
  const parentOf = new Map<number, number>();
  childrenOf.set(VIRTUAL_ROOT, tree.roots);
  const walk = (nodes: TreeNode[], parentId: number) => {
    for (const n of nodes) {
      byId.set(n.id, n);
      childrenOf.set(n.id, n.children);
      parentOf.set(n.id, parentId);
      walk(n.children, n.id);
    }
  };
  walk(tree.roots, VIRTUAL_ROOT);
  return { byId, childrenOf, parentOf };
}

/** Walk root→leaf, picking the selected child at each fork (default: newest). */
function computePath(
  childrenOf: Map<number, TreeNode[]>,
  selection: Map<number, number>,
): PathStep[] {
  const path: PathStep[] = [];
  let parentId = VIRTUAL_ROOT;
  let siblings = childrenOf.get(VIRTUAL_ROOT) ?? [];
  while (siblings.length > 0) {
    const selId = selection.get(parentId);
    if (selId === CONTINUE) break; // empty slot chosen → stop at this turn
    const fallback = siblings[siblings.length - 1];
    const chosen = siblings.find((s) => s.id === selId) ?? fallback;
    path.push({ node: chosen, siblings, parentId });
    parentId = chosen.id;
    siblings = childrenOf.get(chosen.id) ?? [];
  }
  return path;
}

/** Branch-fork analysis for a node's children. */
function forkOf(
  children: TreeNode[],
  selId: number | undefined,
): {
  hasEmpty: boolean;
  options: (TreeNode | null)[]; // null = the empty "continue here" slot
  activeIndex: number;
} | null {
  if (children.length === 0) return null;
  const hasEmpty = children.every((c) => c.branched); // only explicit branches
  if (!hasEmpty && children.length <= 1) return null; // a lone continuation
  const options: (TreeNode | null)[] = hasEmpty ? [null, ...children] : children;
  let activeIndex: number;
  if (hasEmpty && selId === CONTINUE) {
    activeIndex = 0;
  } else {
    const ci = children.findIndex((c) => c.id === selId);
    const resolved = ci >= 0 ? ci : children.length - 1; // default: newest
    activeIndex = hasEmpty ? resolved + 1 : resolved;
  }
  return { hasEmpty, options, activeIndex };
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
  const [recall, setRecall] = useState<RecallBlock | null>(null);
  // Index kept in a ref so it's fresh synchronously after a load (selectPathTo
  // runs right after) while still triggering re-render via the `version` bump.
  const indexRef = useRef<NodeIndex>(
    indexNodes({ roots: [], count: 0, contextWindow: null }),
  );
  const [version, setVersion] = useState(0);
  const leafRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await api.getTree();
      indexRef.current = indexNodes(t);
      setTree(t);
      if (t.contextWindow != null) setContextWindow(t.contextWindow);
      setVersion((v) => v + 1);
      setLoading(false);
    } catch (err) {
      setError(errMessage(err));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  // Point the active path at a specific turn by selecting it along its ancestry.
  // Uses the nesting-derived parent map (robust even if nodes lack parent_turn_id).
  const selectPathTo = useCallback((turnId: number) => {
    const { parentOf } = indexRef.current;
    setSelection((prev) => {
      const next = new Map(prev);
      let child = turnId;
      let parent = parentOf.get(turnId);
      while (parent !== undefined) {
        next.set(parent, child);
        if (parent === VIRTUAL_ROOT) break;
        child = parent;
        parent = parentOf.get(parent);
      }
      return next;
    });
  }, []);

  const runStream = useCallback(
    async (
      userText: string,
      stream: (
        onToken: (c: string) => void,
        onRecall: (block: RecallBlock) => void,
      ) => Promise<{
        id: number | null;
        contextWindow: number | null;
      }>,
    ) => {
      setSending(true);
      setError(null);
      // Keep the previous recall block visible until a new recall event replaces
      // it (mirrors the backend keeping the "current" block until overwritten).
      setStreaming({ user: userText, reply: '' });
      try {
        const res = await stream(
          (c) => setStreaming((s) => (s ? { ...s, reply: s.reply + c } : s)),
          (block) => setRecall(block),
        );
        await load();
        if (res.id != null) selectPathTo(res.id);
        if (res.contextWindow != null) setContextWindow(res.contextWindow);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setSending(false);
        setStreaming(null);
      }
    },
    [load, selectPathTo],
  );

  const dismissRecall = useCallback(() => setRecall(null), []);

  const send = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      void runStream(trimmed, (onToken, onRecall) =>
        api.sendMessageStream(
          // Active leaf to continue from (omit for a brand-new conversation).
          {
            message: trimmed,
            parentTurnId: leafRef.current ?? undefined,
            recall: getRecallEnabled(),
          },
          onToken,
          undefined,
          onRecall,
        ),
      );
    },
    [runStream],
  );

  const branch = useCallback(
    (
      parentTurnId: number,
      message: string,
      paragraphIndex?: number,
      withContext = true,
    ) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      void runStream(trimmed, (onToken, onRecall) =>
        api.branchMessage(
          {
            parentTurnId,
            message: trimmed,
            paragraphIndex,
            recall: getRecallEnabled(),
            // "Without context" → fresh branch, no prior turns injected.
            ...(withContext ? {} : { contextTurns: 0 }),
          },
          onToken,
          undefined,
          onRecall,
        ),
      );
    },
    [runStream],
  );

  const switchSibling = useCallback(
    (parentId: number, siblings: TreeNode[], dir: 1 | -1) => {
      setSelection((prev) => {
        const curId = prev.get(parentId);
        const curIdx =
          curId != null && siblings.some((s) => s.id === curId)
            ? siblings.findIndex((s) => s.id === curId)
            : siblings.length - 1;
        const nextIdx = (curIdx + dir + siblings.length) % siblings.length;
        const next = new Map(prev);
        next.set(parentId, siblings[nextIdx].id);
        return next;
      });
    },
    [],
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

  // Cycle a node's branch switcher (incl. the empty "continue here" slot).
  const cycleFork = useCallback((parentId: number, dir: 1 | -1) => {
    setSelection((prev) => {
      const children = indexRef.current.childrenOf.get(parentId) ?? [];
      const f = forkOf(children, prev.get(parentId));
      if (!f) return prev;
      const nextIdx = (f.activeIndex + dir + f.options.length) % f.options.length;
      const opt = f.options[nextIdx];
      const next = new Map(prev);
      next.set(parentId, opt === null ? CONTINUE : opt.id);
      return next;
    });
  }, []);

  // Recomputed when the tree (version) or selection changes.
  void version;
  const steps = computePath(indexRef.current.childrenOf, selection);
  const path: PathEntry[] = steps.map((s) => {
    const children = indexRef.current.childrenOf.get(s.node.id) ?? [];
    const f = forkOf(children, selection.get(s.node.id));
    const fork: ForkInfo | null = f
      ? {
          parentId: s.node.id,
          current: f.hasEmpty ? f.activeIndex : f.activeIndex + 1,
          total: children.length,
          paragraphIndex: f.options[f.activeIndex]?.paragraphIndex ?? null,
        }
      : null;
    return { ...s, fork };
  });
  const activeIds = new Set(path.map((e) => e.node.id));
  const activeLeafId = path.length ? path[path.length - 1].node.id : null;
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
    dismissRecall,
    send,
    branch,
    switchSibling,
    cycleFork,
    selectPathTo,
    remove,
    reload: load,
  };
}
