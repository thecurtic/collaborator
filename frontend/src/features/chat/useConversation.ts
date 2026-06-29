import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/collaborator';
import type { ConversationTree, TreeNode } from '@/domain/models';

const VIRTUAL_ROOT = 0;

export interface PathEntry {
  node: TreeNode;
  /** All children at this level (siblings of `node`) — for the branch switcher. */
  siblings: TreeNode[];
  /** Parent id (VIRTUAL_ROOT for top-level). Keys the selection map. */
  parentId: number;
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
): PathEntry[] {
  const path: PathEntry[] = [];
  let parentId = VIRTUAL_ROOT;
  let siblings = childrenOf.get(VIRTUAL_ROOT) ?? [];
  while (siblings.length > 0) {
    const fallback = siblings[siblings.length - 1];
    const selId = selection.get(parentId);
    const chosen = siblings.find((s) => s.id === selId) ?? fallback;
    path.push({ node: chosen, siblings, parentId });
    parentId = chosen.id;
    siblings = childrenOf.get(chosen.id) ?? [];
  }
  return path;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function useConversation(reloadSignal: number) {
  const [selection, setSelection] = useState<Map<number, number>>(new Map());
  const [tree, setTree] = useState<ConversationTree>({ roots: [], count: 0 });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  // Index kept in a ref so it's fresh synchronously after a load (selectPathTo
  // runs right after) while still triggering re-render via the `version` bump.
  const indexRef = useRef<NodeIndex>(indexNodes({ roots: [], count: 0 }));
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await api.getTree();
      indexRef.current = indexNodes(t);
      setTree(t);
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
      stream: (onToken: (c: string) => void) => Promise<{
        id: number | null;
        contextWindow: number | null;
      }>,
    ) => {
      setSending(true);
      setError(null);
      setStreaming({ user: userText, reply: '' });
      try {
        const res = await stream((c) =>
          setStreaming((s) => (s ? { ...s, reply: s.reply + c } : s)),
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

  const send = useCallback(
    (message: string) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      void runStream(trimmed, (onToken) =>
        api.sendMessageStream({ message: trimmed }, onToken),
      );
    },
    [runStream],
  );

  const branch = useCallback(
    (parentTurnId: number, message: string, paragraphIndex?: number) => {
      const trimmed = message.trim();
      if (!trimmed) return;
      void runStream(trimmed, (onToken) =>
        api.branchMessage(
          { parentTurnId, message: trimmed, paragraphIndex },
          onToken,
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

  // Recomputed when the tree (version) or selection changes.
  void version;
  const path = computePath(indexRef.current.childrenOf, selection);
  const activeIds = new Set(path.map((e) => e.node.id));

  return {
    path,
    tree,
    activeIds,
    loading,
    sending,
    error,
    contextWindow,
    streaming,
    send,
    branch,
    switchSibling,
    selectPathTo,
    remove,
    reload: load,
  };
}
