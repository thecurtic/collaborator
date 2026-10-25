import { Fragment } from 'react';
import { isWebUrl } from '@/api/agents';

/** Plain text with its http(s) links made clickable (agent messages and
 * question cards: a test build's link arrives this way). */
export function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        isWebUrl(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer"
             className="break-all text-primary underline underline-offset-2">{p}</a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
