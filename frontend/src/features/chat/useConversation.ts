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

/** The main line at a fork = the newest non-branched (continuation) child. */
function mainChild(siblings: TreeNode[]): TreeNode | undefined {
  for (let i = siblings.length - 1; i >= 0; i--) {
    if (!siblings[i].branched) return siblings[i];
  }
  return undefined;
}

/**
 * Walk root→leaf following the MAIN line (`0/n`) by default — the non-branched
 * continuation. Branches are opt-in: only followed when explicitly selected. If a
 * node has no continuation (all children are branches), the main line ends there.
 */
function computePath(
  childrenOf: Map<number, TreeNode[]>,
  selection: Map<number, number>,
): PathStep[] {
  const path: PathStep[] = [];
  let parentId = VIRTUAL_ROOT;
  let siblings = childrenOf.get(VIRTUAL_ROOT) ?? [];
  while (siblings.length > 0) {
    const selId = selection.get(parentId);
    if (selId === CONTINUE) break; // "0" with no continuation → stop here
    let chosen =
      selId !== undefined ? siblings.find((s) => s.id === selId) : undefined;
    if (!chosen) chosen = mainChild(siblings); // default: the main line
    if (!chosen) break; // only branches, none selected → main line ends
    path.push({ node: chosen, siblings, parentId });
    parentId = chosen.id;
    siblings = childrenOf.get(chosen.id) ?? [];
  }
  return path;
}

/**
 * Branch switcher for a node's children: position 0 = the main line, 1..n = the
 * branches (branched children). null if there are no branches (linear turn).
 */
function forkOf(
  children: TreeNode[],
  selId: number | undefined,
): { current: number; total: number; paragraphIndex: number | null } | null {
  const branches = children.filter((c) => c.branched);
  if (branches.length === 0) return null;
  let current = 0; // 0 = main line
  let paragraphIndex: number | null = null;
  if (selId !== undefined && selId !== CONTINUE) {
    const bi = branches.findIndex((b) => b.id === selId);
    if (bi >= 0) {
      current = bi + 1;
      paragraphIndex = branches[bi].paragraphIndex;
    }
  }
  return { current, total: branches.length, paragraphIndex };
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
  // Live tool-calling status line ("what it's doing"), cleared each turn.
  const [status, setStatus] = useState('');
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
        onStatus: (t: string) => void,
      ) => Promise<{
        id: number | null;
        contextWindow: number | null;
      }>,
    ) => {
      setSending(true);
      setError(null);
      setRecall(null);
      setStatus('');
      setStreaming({ user: userText, reply: '' });
      try {
        const res = await stream(
          (c) => setStreaming((s) => (s ? { ...s, reply: s.reply + c } : s)),
          (block) => setRecall(block),
          (t) => setStatus(t),
        );
        await load();
        if (res.id != null) selectPathTo(res.id);
        if (res.contextWindow != null) setContextWindow(res.contextWindow);
      } catch (err) {
        setError(errMessage(err));
      } finally {
        setSending(false);
        setStreaming(null);
        setStatus('');
        // Persisted recall now comes from the tree (node.recall) on reload.
        setRecall(null);
      }
    },
    [load, selectPathTo],
  );

  const send = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      void runStream(trimmed, (onToken, onRecall, onStatus) =>
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
          onStatus,
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
      void runStream(trimmed, (onToken, onRecall, onStatus) =>
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
          onStatus,
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

  const renameTurn = useCallback(
    async (turnId: number, name: string) => {
      setError(null);
      try {
        await api.renameTurn(turnId, name);
        await load();
      } catch (err) {
        setError(errMessage(err));
      }
    },
    [load],
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

  // Recomputed when the tree (version) or selection changes.
  void version;
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
    status,
    send,
    branch,
    switchSibling,
    cycleFork,
    selectPathTo,
    remove,
    renameTurn,
    reload: load,
  };
}
