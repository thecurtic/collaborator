// Editable names for conversation trees (roots), keyed by the root turn id.
// INTERIM: stored in localStorage until the backend persists a tree/branch name
// (then this swaps to reading node.name from the tree). Kept tiny + tolerant.

const KEY = 'collaborator_tree_names';

function readAll(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function getTreeName(rootId: number): string | null {
  return readAll()[String(rootId)] ?? null;
}

export function setTreeName(rootId: number, name: string): void {
  const all = readAll();
  const trimmed = name.trim();
  if (trimmed) all[String(rootId)] = trimmed;
  else delete all[String(rootId)];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
