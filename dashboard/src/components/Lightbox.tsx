'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { bytes } from '@/lib/format';
import type { AttachmentMeta } from '@/lib/types';

// Full-size viewer. Images render straight from the stored base64 WebP; gzip'd logs are
// inflated in the browser with DecompressionStream.

const IMAGE_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Loaded = { kind: 'image'; src: string } | { kind: 'text'; text: string; blob: Blob } | { kind: 'file'; blob: Blob };

export function Lightbox({ attachment, onClose, onStep }: { attachment: AttachmentMeta; onClose: () => void; onStep?: (dir: 1 | -1) => void }) {
  const [state, setState] = useState<Loaded | { kind: 'error'; msg: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    api.attachment(attachment.id).then(
      async (a) => {
        let result: Loaded;
        if (IMAGE_TYPES.has(a.mime_type)) {
          result = { kind: 'image', src: `data:${a.mime_type};base64,${a.payload_b64}` };
        } else {
          let data = b64ToBytes(a.payload_b64);
          if (a.compression_type === 'gzip') data = await inflate(data);
          const blob = new Blob([data], { type: a.mime_type });
          result = a.mime_type === 'application/pdf' ? { kind: 'file', blob } : { kind: 'text', text: new TextDecoder().decode(data), blob };
        }
        if (!cancelled) setState(result);
      },
      (e) => !cancelled && setState({ kind: 'error', msg: e.message }),
    );
    return () => {
      cancelled = true;
    };
  }, [attachment.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onStep?.(1);
      if (e.key === 'ArrowLeft') onStep?.(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onStep]);

  const download = () => {
    if (!state || state.kind === 'error') return;
    const blob = state.kind === 'image' ? null : state.blob;
    const href = blob ? URL.createObjectURL(blob) : (state as { src: string }).src;
    const a = Object.assign(document.createElement('a'), { href, download: attachment.file_name.replace(/\.gz$/, '') });
    a.click();
    if (blob) setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={attachment.file_name} className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 py-2 text-[13px] text-zinc-200" onClick={(e) => e.stopPropagation()}>
        <span className="truncate font-medium">{attachment.file_name}</span>
        <span className="text-zinc-400">
          {attachment.mime_type} · {attachment.compression_type} · {bytes(attachment.compressed_size)} stored
        </span>
        <div className="ml-auto flex gap-2">
          {onStep && (
            <>
              <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => onStep(-1)} aria-label="Previous">
                ←
              </button>
              <button className="rounded px-2 py-1 hover:bg-white/10" onClick={() => onStep(1)} aria-label="Next">
                →
              </button>
            </>
          )}
          <button className="rounded px-2 py-1 hover:bg-white/10" onClick={download} disabled={!state || state.kind === 'error'}>
            Download
          </button>
          <button className="rounded px-2 py-1 text-lg leading-none hover:bg-white/10" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        {!state && <span className="text-zinc-400">Loading…</span>}
        {state?.kind === 'error' && <span className="text-red-300">{state.msg}</span>}
        {state?.kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={state.src} alt={attachment.file_name} className="max-h-full max-w-full rounded object-contain shadow-2xl" />
        )}
        {state?.kind === 'text' && (
          <pre className="h-full w-full max-w-5xl overflow-auto rounded bg-zinc-950 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-zinc-200">{state.text}</pre>
        )}
        {state?.kind === 'file' && (
          <div className="text-center text-zinc-300">
            <p>PDF documents are not previewed inline.</p>
            <button className="mt-3 rounded bg-white/10 px-3 py-1.5 hover:bg-white/20" onClick={download}>
              Download {attachment.file_name}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
