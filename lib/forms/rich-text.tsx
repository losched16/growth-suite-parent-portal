// Lightweight, XSS-safe formatting for form text blocks (Sonia's ask:
// "there is no html or rich editor"). Supports a markdown subset:
//   **bold**   *italic*   [link text](https://url)
//   lines starting "- " become bullet lists
//   lines starting "## " become subheadings
// Rendered as React elements — never dangerouslySetInnerHTML — so
// nothing an editor types can inject script. Unknown syntax passes
// through as plain text. Blank lines separate paragraphs.

import React from 'react';

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

// Inline: **bold**, *italic*, [text](url). Single pass, no nesting.
function parseInline(s: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = s;
  let k = 0;
  const RE = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)\s]+)\))/;
  while (rest.length > 0) {
    const m = RE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[1]) out.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3]) out.push(<em key={k++}>{m[4]}</em>);
    else if (m[5]) {
      const href = m[7];
      if (SAFE_HREF.test(href)) {
        out.push(
          <a key={k++} href={href} target="_blank" rel="noopener noreferrer" className="underline text-blue-700 hover:text-blue-900">
            {m[6]}
          </a>,
        );
      } else {
        out.push(m[6]); // unsafe scheme → just the text
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export function FormattedText({ text, className }: { text: string; className?: string }) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let bullets: React.ReactNode[] = [];
  let k = 0;

  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(<ul key={k++} className="list-disc pl-5 space-y-0.5">{bullets}</ul>);
    bullets = [];
  };

  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      bullets.push(<li key={k++}>{parseInline(line.replace(/^\s*-\s+/, ''))}</li>);
      continue;
    }
    flushBullets();
    if (/^##\s+/.test(line)) {
      blocks.push(<div key={k++} className="font-semibold text-gray-900 mt-1">{parseInline(line.replace(/^##\s+/, ''))}</div>);
    } else if (line.trim() === '') {
      blocks.push(<div key={k++} className="h-2" />);
    } else {
      blocks.push(<div key={k++}>{parseInline(line)}</div>);
    }
  }
  flushBullets();
  return <div className={className}>{blocks}</div>;
}
