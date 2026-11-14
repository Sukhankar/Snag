'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { fullTime, relTime } from '@/lib/format';
import type { AttachmentMeta, Message, TicketDetail } from '@/lib/types';
import { useCan } from './me';

// Thread with a hard visual split between client-visible replies and private dev notes.

export function Conversation({ ticket, onSent, onOpenAttachment }: { ticket: TicketDetail; onSent: (m: Message) => void; onOpenAttachment: (a: AttachmentMeta) => void }) {
  const can = useCan();
  const canReply = can('tickets.reply');
  const canNote = can('tickets.note');
  const [internal, setInternal] = useState(!canReply && canNote);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef<HTMLLIElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [ticket.messages.length]);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      onSent(await api.postMessage(ticket.id, text, internal));
      setBody('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const byMessage = new Map<string, AttachmentMeta[]>();
  for (const a of ticket.attachments) if (a.message_id) byMessage.set(a.message_id, [...(byMessage.get(a.message_id) ?? []), a]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <span className="label">Conversation</span>
        <span className="text-[11px] text-zinc-400">
          {ticket.messages.filter((m) => m.is_internal).length} internal · {ticket.messages.filter((m) => !m.is_internal).length} public
        </span>
      </div>

      <ol className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3" aria-live="polite">
        {ticket.messages.map((m) => {
          const atts = byMessage.get(m.id);
          if (m.author_type === 'system') {
            return (
              <li key={m.id} className={`text-center text-[11px] ${m.is_internal ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'}`}>
                {m.is_internal && '🔒 '}
                {m.body} · {relTime(m.created_at)}
              </li>
            );
          }
          const client = m.author_type === 'client';
          return (
            <li key={m.id} className={`flex flex-col ${client ? 'items-start' : 'items-end'}`}>
              <div
                className={`max-w-[90%] rounded-lg px-3 py-2 whitespace-pre-wrap ${
                  m.is_internal
                    ? 'border border-dashed border-amber-400 bg-amber-50 dark:border-amber-500/50 dark:bg-amber-500/10'
                    : client
                      ? 'bg-zinc-100 dark:bg-zinc-800'
                      : 'bg-indigo-600 text-white'
                }`}
              >
                {m.is_internal && <span className="mb-0.5 block text-[10px] font-bold tracking-wide text-amber-700 uppercase dark:text-amber-400">🔒 Internal note</span>}
                {m.body}
                {atts && (
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {atts.map((a) => (
                      <button key={a.id} onClick={() => onOpenAttachment(a)} className="size-14 overflow-hidden rounded border border-black/10 bg-white/50" title={a.file_name}>
                        {a.thumbnail_b64 ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`data:image/webp;base64,${a.thumbnail_b64}`} alt={a.file_name} className="size-full object-cover" />
                        ) : (
                          <span className="text-[9px] break-all text-zinc-600">{a.file_name}</span>
                        )}
                      </button>
                    ))}
                  </span>
                )}
              </div>
              <span className="mt-0.5 text-[10px] text-zinc-400" title={fullTime(m.created_at)}>
                {client ? ticket.reporter_name || 'Client' : m.author_id || 'Support'} · {relTime(m.created_at)}
              </span>
            </li>
          );
        })}
        <li ref={bottom} aria-hidden />
      </ol>

      {!canReply && !canNote ? (
        <p className="border-t border-zinc-200 p-3 text-center text-[12px] text-zinc-500 dark:border-zinc-800">You have read-only access to this conversation.</p>
      ) : (
      <div className={`border-t p-3 ${internal ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5' : 'border-zinc-200 dark:border-zinc-800'}`}>
        <div className="mb-2 flex gap-1 rounded-md bg-zinc-100 p-0.5 text-[12px] dark:bg-zinc-800" role="radiogroup" aria-label="Message visibility">
          <button
            role="radio"
            aria-checked={!internal}
            disabled={!canReply}
            title={canReply ? undefined : 'Your role cannot reply to clients'}
            onClick={() => setInternal(false)}
            className={`flex-1 rounded px-2 py-1 font-medium ${!internal ? 'bg-white text-indigo-700 shadow-sm dark:bg-zinc-900 dark:text-indigo-300' : 'text-zinc-500'}`}
          >
            Public reply
          </button>
          <button
            role="radio"
            aria-checked={internal}
            disabled={!canNote}
            title={canNote ? undefined : 'Your role cannot write internal notes'}
            onClick={() => setInternal(true)}
            className={`flex-1 rounded px-2 py-1 font-medium ${internal ? 'bg-white text-amber-700 shadow-sm dark:bg-zinc-900 dark:text-amber-400' : 'text-zinc-500'}`}
          >
            🔒 Internal note
          </button>
        </div>
        <textarea
          className="input min-h-[76px] resize-y"
          placeholder={internal ? 'Private note for the dev team — never shown to the client' : `Reply to ${ticket.reporter_name || 'the client'} — visible in their widget`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          aria-label={internal ? 'Internal note' : 'Public reply'}
        />
        {error && (
          <p role="alert" className="mt-1 text-[12px] text-red-600">
            {error}
          </p>
        )}
        <div className="mt-2 flex items-center">
          <span className="text-[11px] text-zinc-500">{internal ? 'Only your team can see this.' : 'The client will see this instantly.'} Ctrl+Enter to send.</span>
          <button
            onClick={send}
            disabled={sending || !body.trim()}
            className={`ml-auto rounded-md px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50 ${internal ? 'bg-amber-600 hover:bg-amber-500' : 'bg-indigo-600 hover:bg-indigo-500'}`}
          >
            {internal ? 'Add note' : 'Send reply'}
          </button>
        </div>
      </div>
      )}
    </>
  );
}
