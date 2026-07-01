// Render plain text with any http(s) URLs turned into clickable links.
// Used for school-authored messages (e.g. the FACTS confirmation message)
// that are stored as plain text but contain links the parent needs to click.

import React from 'react';

export function LinkifyText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noopener noreferrer"
            className="underline break-all font-medium"
            style={{ color: 'var(--brand-fg, #047857)' }}
          >
            {p}
          </a>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </>
  );
}
