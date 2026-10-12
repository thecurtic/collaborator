import type {
  ConversationState,
  ConversationTree,
  TreeNode,
} from '@/domain/models';

/**
 * Pure local predictions of the backend's tree mutations, for optimistic UI:
 * apply the expected result via applyTree immediately, confirm with the API
 * in the background, and on failure resync from the server (no rollback
 * bookkeeping — the server is the source of truth).
 *
 * All functions clone only along the edited path (structural sharing) and
 * return the input tree unchanged when the id isn't found.
 */

/**
 * DELETE /api/messages/{id}[?subtree] — subtree drops the node and all
 * descendants; single delete reparents the children up one level, splicing
 * them into the parent's child list at the deleted node's position (deleted
 * roots promote their children to roots).
 */
export function removeNode(
  tree: ConversationTree,
  id: number,
  subtree: boolean,
): ConversationTree {
  const edit = (
    nodes: TreeNode[],
    parentId: number | null,
  ): TreeNode[] | null => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx !== -1) {
      const next = [...nodes];
      if (subtree) {
        next.splice(idx, 1);
      } else {
        next.splice(
          idx,
          1,
          ...nodes[idx].children.map((c) => ({
            ...c,
            parentTurnId: parentId,
          })),
        );
      }
      return next;
    }
    for (let i = 0; i < nodes.length; i++) {
      const edited = edit(nodes[i].children, nodes[i].id);
      if (edited) {
        const next = [...nodes];
        next[i] = { ...nodes[i], children: edited };
        return next;
      }
    }
    return null;
  };
  const roots = edit(tree.roots, null);
  return roots ? { ...tree, roots } : tree;
}

/** Replace one node via `fn`, cloning the path to it. */
function mapNode(
  tree: ConversationTree,
  id: number,
  fn: (node: TreeNode) => TreeNode,
): ConversationTree {
  const edit = (nodes: TreeNode[]): TreeNode[] | null => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx !== -1) {
      const next = [...nodes];
      next[idx] = fn(nodes[idx]);
      return next;
    }
    for (let i = 0; i < nodes.length; i++) {
      const edited = edit(nodes[i].children);
      if (edited) {
        const next = [...nodes];
        next[i] = { ...nodes[i], children: edited };
        return next;
      }
    }
    return null;
  };
  const roots = edit(tree.roots);
  return roots ? { ...tree, roots } : tree;
}

/**
 * POST /api/turns/{id}/title — apply the returned LLM title locally. The
 * response is the source of truth; an immediate refetch can race the
 * backend's write and clobber the list with the stale title.
 */
export function setNodeTitle(
  tree: ConversationTree,
  id: number,
  title: string,
): ConversationTree {
  return mapNode(tree, id, (n) => ({ ...n, title: title || null }));
}

/** PATCH /api/turns/{id}/name — empty string clears the name. */
export function renameNode(
  tree: ConversationTree,
  id: number,
  name: string,
): ConversationTree {
  return mapNode(tree, id, (n) => ({ ...n, name: name.trim() || null }));
}

/** PATCH /api/turns/{id}/state — applies to the node's ENTIRE subtree. */
export function setSubtreeState(
  tree: ConversationTree,
  id: number,
  state: ConversationState,
): ConversationTree {
  const stamp = (n: TreeNode): TreeNode => ({
    ...n,
    state,
    children: n.children.map(stamp),
  });
  return mapNode(tree, id, stamp);
}

/** PUT /api/chats/{id}/tags — the chat's tags, on its root node. */
export function setChatTags(
  tree: ConversationTree,
  rootId: number,
  tags: string[],
): ConversationTree {
  return mapNode(tree, rootId, (n) => ({ ...n, chatTags: [...tags] }));
}
