'use client';

// Drawn-signature canvas. Used by both check-in and check-out flows.
// Renders a touch-friendly pad sized to the viewport, with Clear +
// Confirm buttons. On Confirm, dataURL is written to a hidden input
// the surrounding <form> submits — the page-level form handles the
// actual POST to /api/attendance/event so we don't need fetch here.
//
// Mobile-first: the canvas is responsive and the touch handlers are
// configured for finger input. Tested on iOS Safari + Android Chrome.

import { useEffect, useRef, useState } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { RotateCcw, Check } from 'lucide-react';

interface Props {
  hiddenInputName?: string;   // form field that receives the base64 PNG
  label?: string;
  brandColor?: string;
}

export function SignatureCanvasField({
  hiddenInputName = 'signature_png',
  label = 'Sign with your finger to confirm',
  brandColor = '#047857',
}: Props) {
  const canvasRef = useRef<SignatureCanvas | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(360);
  const [hasInk, setHasInk] = useState(false);
  const [confirmedDataUrl, setConfirmedDataUrl] = useState<string>('');

  // Size canvas to container width.
  useEffect(() => {
    function resize() {
      const w = containerRef.current?.getBoundingClientRect().width ?? 360;
      setWidth(Math.max(200, Math.floor(w)));
    }
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  function clear() {
    canvasRef.current?.clear();
    setHasInk(false);
    setConfirmedDataUrl('');
  }

  function confirm() {
    const canvas = canvasRef.current;
    if (!canvas || canvas.isEmpty()) return;
    const dataUrl = canvas.getCanvas().toDataURL('image/png');
    setConfirmedDataUrl(dataUrl);
  }

  return (
    <div className="space-y-2" ref={containerRef}>
      <div className="text-sm font-medium text-gray-800">{label}</div>
      <div
        className={`rounded-md border-2 ${confirmedDataUrl ? 'border-emerald-400' : 'border-dashed border-gray-300'} bg-white`}
        style={{ touchAction: 'none' }}
      >
        <SignatureCanvas
          ref={canvasRef}
          penColor={brandColor}
          canvasProps={{
            width,
            height: 180,
            className: 'rounded-md',
            style: { width: '100%', height: 180, display: 'block', touchAction: 'none' },
          }}
          onBegin={() => setHasInk(true)}
        />
      </div>

      <input type="hidden" name={hiddenInputName} value={confirmedDataUrl} />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={clear}
          disabled={!hasInk && !confirmedDataUrl}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" /> Clear
        </button>
        {!confirmedDataUrl ? (
          <button
            type="button"
            onClick={confirm}
            disabled={!hasInk}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            style={{ background: brandColor }}
          >
            <Check className="h-3 w-3" /> Lock signature
          </button>
        ) : (
          <span className="text-xs text-emerald-700">Signature locked — submit below.</span>
        )}
      </div>
    </div>
  );
}
