import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// Links open in a new tab; everything else is styled via the `.markdown` class
// (see index.css). Raw HTML is not allowed (react-markdown default) — safe for
// untrusted LLM output.
const components = {
  a: (props: ComponentPropsWithoutRef<'a'>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

/** Render Markdown (GitHub-flavored) for assistant messages. */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
