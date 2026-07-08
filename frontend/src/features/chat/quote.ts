/**
 * Build a composer-ready quote for replying to a paragraph. Truncated on a
 * word boundary — the model has the full turn in context, so a distinctive
 * prefix is enough to bind the answer to its referent (and saves tokens vs.
 * quoting whole paragraphs).
 */
export function quoteForReply(text: string, maxChars = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return `> ${collapsed}`;
  const cut = collapsed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  // Only break at the space when it doesn't cost too much of the snippet.
  const snippet = (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut)
    .replace(/[\s,;:.]+$/, '');
  return `> ${snippet}…`;
}

/** Append a quote block to a draft, keeping quote/answer sections separated. */
export function appendQuoteToDraft(draft: string, quote: string): string {
  const base = draft.trimEnd();
  return base ? `${base}\n\n${quote}\n\n` : `${quote}\n\n`;
}
