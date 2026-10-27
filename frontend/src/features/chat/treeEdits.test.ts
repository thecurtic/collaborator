import { describe, expect, it } from 'vitest';
import type { ConversationTree, TreeNode } from '@/domain/models';
import {
  removeNode,
  renameNode,
  setChatTags,
  setSubtreeState,
} from './treeEdits';

function node(id: number, children: TreeNode[] = []): TreeNode {
  return {
    id,
    role: 'user',
    content: `t${id}`,
    preview: `t${id}`,
    paragraphs: [`t${id}`],
    parentTurnId: null,
    paragraphIndex: null,
    branched: false,
    name: null,
    label: null,
    title: null,
    chatTags: [],
    state: 'seed',
    recall: null,
    tools: [],
    attachments: [],
    children,
  };
}

// 1 → (2 → (4, 5), 3) ; second root 9
function tree(): ConversationTree {
  return {
    roots: [node(1, [node(2, [node(4), node(5)]), node(3)]), node(9)],
    count: 6,
    contextWindow: null,
  };
}

const ids = (nodes: TreeNode[]): number[] => nodes.map((n) => n.id);

describe('removeNode', () => {
  it('subtree delete drops the node and all descendants', () => {
    const t = removeNode(tree(), 2, true);
    expect(ids(t.roots[0].children)).toEqual([3]);
  });

  it('single delete splices children up at the deleted position', () => {
    const t = removeNode(tree(), 2, false);
    expect(ids(t.roots[0].children)).toEqual([4, 5, 3]);
    expect(t.roots[0].children[0].parentTurnId).toBe(1);
  });

  it('single-deleting a root promotes its children to roots', () => {
    const t = removeNode(tree(), 1, false);
    expect(ids(t.roots)).toEqual([2, 3, 9]);
    expect(t.roots[0].parentTurnId).toBeNull();
  });

  it('returns the tree unchanged (same reference) for unknown ids', () => {
    const t = tree();
    expect(removeNode(t, 777, true)).toBe(t);
  });

  it('does not mutate the input tree', () => {
    const t = tree();
    removeNode(t, 2, true);
    expect(ids(t.roots[0].children)).toEqual([2, 3]);
  });
});

describe('renameNode', () => {
  it('sets a trimmed name on the target only', () => {
    const t = renameNode(tree(), 2, '  Ideas  ');
    expect(t.roots[0].children[0].name).toBe('Ideas');
    expect(t.roots[0].name).toBeNull();
  });

  it('clears the name for empty strings', () => {
    const named = renameNode(tree(), 2, 'X');
    expect(renameNode(named, 2, '  ').roots[0].children[0].name).toBeNull();
  });
});

describe('setSubtreeState', () => {
  it('stamps the state on the whole subtree, siblings untouched', () => {
    const t = setSubtreeState(tree(), 1, 'tree');
    const root = t.roots[0];
    expect(root.state).toBe('tree');
    expect(root.children[0].state).toBe('tree');
    expect(root.children[0].children[0].state).toBe('tree');
    expect(t.roots[1].state).toBe('seed');
  });
});

describe('setChatTags', () => {
  it('replaces the root\'s chat tags without touching other nodes', () => {
    const before = tree();
    const t = setChatTags(before, 1, ['project', 'garden']);
    expect(t.roots[0].chatTags).toEqual(['project', 'garden']);
    expect(t.roots[0].children[0].chatTags).toEqual([]);
    expect(t.roots[1].chatTags).toEqual([]);
    expect(before.roots[0].chatTags).toEqual([]); // input not mutated
    expect(setChatTags(t, 1, []).roots[0].chatTags).toEqual([]);
  });
});
