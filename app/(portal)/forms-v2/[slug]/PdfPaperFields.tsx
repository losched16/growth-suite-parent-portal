'use client';

// "Paper mode" for official-PDF forms: renders the actual PDF pages in
// the browser (pdf.js) and positions real inputs directly on the
// document, exactly where the PDF's own fillable fields sit. Parents
// fill the card itself — no translated web form. Inputs are named by
// the form's block keys, so they submit through the standard form
// pipeline unchanged (validation, co-sign, PDF flattening, storage).

import { useEffect, useRef, useState } from 'react';

interface PaperBlock {
  key: string;
  pdf_field: string;
  type: string;              // text | checkbox | select
  required?: boolean;
  label?: string;
  defaultValue?: string;
  options?: Array<{ value: string; label: string }>;
}

interface Geometry {
  pdf: string; // base64
  pages: Array<{ index: number; width: number; height: number }>;
  fields: Array<{
    name: string; type: string; page: number;
    rect: { x: number; y: number; w: number; h: number };
    options?: string[];
  }>;
}

const RENDER_SCALE = 1.6; // canvas oversampling for crisp text

export function PdfPaperFields({ formId, blocks }: { formId: string; blocks: PaperBlock[] }) {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/portal-forms/pdf-template/${formId}`);
        if (!r.ok) throw new Error(`template fetch failed (${r.status})`);
        const g: Geometry = await r.json();
        if (cancelled) return;
        setGeo(g);
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        const raw = atob(g.pdf);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        for (let p = 1; p <= doc.numPages; p++) {
          if (cancelled) return;
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const canvas = canvasRefs.current[p - 1];
          if (!canvas) continue;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d')!;
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [formId]);

  if (err) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        The document viewer couldn&rsquo;t load ({err}). Please refresh — if it persists, contact the school office.
      </div>
    );
  }
  if (!geo) {
    return <div className="rounded-md border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">Loading the document…</div>;
  }

  const blockByPdfField = new Map(blocks.map((b) => [b.pdf_field, b]));
  // Radio groups produce one geometry entry per option widget; the block is
  // a select — render it once at the FIRST widget, skip the rest.
  const seenRadio = new Set<string>();

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Fill in the official document below — tap any field to type. Required fields are outlined.
      </p>
      {geo.pages.map((page) => {
        const pageFields = geo.fields.filter((f) => f.page === page.index && f.type !== 'signature');
        return (
          <div
            key={page.index}
            className="relative mx-auto w-full overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm"
          >
            <canvas
              ref={(el) => { canvasRefs.current[page.index] = el; }}
              className="block h-auto w-full"
            />
            {pageFields.map((f, i) => {
              const block = blockByPdfField.get(f.name);
              if (!block) return null;
              if (f.type === 'radio') {
                if (seenRadio.has(f.name)) return null;
                seenRadio.add(f.name);
              }
              // Percent-based placement so the overlay scales with the
              // responsive canvas width.
              const left = (f.rect.x / page.width) * 100;
              const top = ((page.height - f.rect.y - f.rect.h) / page.height) * 100;
              const width = (f.rect.w / page.width) * 100;
              const height = (f.rect.h / page.height) * 100;
              const style: React.CSSProperties = {
                position: 'absolute',
                left: `${left}%`, top: `${top}%`,
                width: `${width}%`, height: `${height}%`,
              };
              const base = 'rounded-[2px] border bg-sky-50/60 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400 text-[11px] sm:text-xs text-gray-900';
              const border = block.required ? 'border-emerald-500/70' : 'border-sky-300/70';
              if (block.type === 'checkbox') {
                return (
                  <input
                    key={`${f.name}-${i}`}
                    type="checkbox"
                    name={block.key}
                    defaultChecked={block.defaultValue === 'true' || block.defaultValue === 'on'}
                    title={block.label || f.name}
                    style={style}
                    className={`${base} ${border} accent-emerald-600 cursor-pointer`}
                  />
                );
              }
              if (block.type === 'select' && block.options?.length) {
                return (
                  <select
                    key={`${f.name}-${i}`}
                    name={block.key}
                    defaultValue={block.defaultValue ?? ''}
                    required={block.required}
                    title={block.label || f.name}
                    style={style}
                    className={`${base} ${border} px-0.5`}
                  >
                    <option value=""></option>
                    {block.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                );
              }
              return (
                <input
                  key={`${f.name}-${i}`}
                  type="text"
                  name={block.key}
                  defaultValue={block.defaultValue ?? ''}
                  required={block.required}
                  title={block.label || f.name}
                  autoComplete="off"
                  style={style}
                  className={`${base} ${border} px-1`}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
