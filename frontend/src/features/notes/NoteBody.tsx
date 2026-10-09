import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const WIKILINK = 'wikilink:';

/**
 * Convert `[[Title]]` / `[[Title|alias]]` / `[[Title#heading]]` into markdown
 * links with a wikilink: pseudo-protocol the renderer can intercept.
 * (Exported for tests.)
 */
export function preprocessWikilinks(body: string): string {
  return body.replace(
    /\[\[([^\][|]+?)(?:\|([^\][]+))?\]\]/g,
    (_m, target: string, alias?: string) => {
      const title = target.split('#')[0].trim();
      const label = (alias ?? target).trim();
      return `[${label}](${WIKILINK}${encodeURIComponent(title)})`;
    },
  );
}

/**
 * Render a vault note body: markdown with tappable [[wikilinks]] that navigate
 * to the linked note. External links open in a new tab as usual.
 */
export function NoteBody({
  body,
  onOpenNote,
}: {
  body: string;
  onOpenNote: (title: string) => void;
}) {
  const components = {
    a: (props: ComponentPropsWithoutRef<'a'>) => {
      const href = props.href ?? '';
      if (href.startsWith(WIKILINK)) {
        const title = decodeURIComponent(href.slice(WIKILINK.length));
        return (
          <a
            {...props}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenNote(title);
            }}
          />
        );
      }
      return <a {...props} target="_blank" rel="noopener noreferrer" />;
    },
  };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        // Let our pseudo-protocol through; everything else gets the default
        // sanitizing transform (which would strip javascript: etc.).
        urlTransform={(url) =>
          url.startsWith(WIKILINK) ? url : defaultUrlTransform(url)
        }
      >
        {preprocessWikilinks(body)}
      </ReactMarkdown>
    </div>
  );
}
