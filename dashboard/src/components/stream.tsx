'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { SnagEvent } from '@/lib/types';

// One EventSource per tab, fanned out to any component via useSnagEvents().

type Listener = (e: SnagEvent) => void;
interface StreamCtx {
  subscribe: (fn: Listener) => () => void;
  connected: boolean;
  /** Increments every time the stream reconnects after a drop; views refetch on change. */
  generation: number;
}

const Ctx = createContext<StreamCtx>({ subscribe: () => () => {}, connected: false, generation: 0 });

const EVENTS = ['ticket.created', 'ticket.updated', 'message.created'] as const;

export function StreamProvider({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [api] = useState<Pick<StreamCtx, 'subscribe'>>(() => ({
    subscribe: (fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
  }));

  useEffect(() => {
    const es = new EventSource('/api/snag/stream');
    let opened = false;
    // Events published while disconnected are lost, so every reconnect bumps the generation
    // and subscribed views reload their data.
    es.addEventListener('ready', () => {
      setConnected(true);
      if (opened) setGeneration((g) => g + 1);
      opened = true;
    });
    es.onerror = () => setConnected(false);
    for (const type of EVENTS) {
      es.addEventListener(type, (e) => {
        let data;
        try {
          data = JSON.parse((e as MessageEvent).data);
        } catch {
          return;
        }
        for (const fn of listeners.current) fn({ type, data } as SnagEvent);
      });
    }
    return () => es.close();
  }, []);

  return <Ctx.Provider value={{ ...api, connected, generation }}>{children}</Ctx.Provider>;
}

/** Subscribe to live events; the latest handler is always used without resubscribing. */
export function useSnagEvents(handler: Listener) {
  const { subscribe } = useContext(Ctx);
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribe((e) => ref.current(e)), [subscribe]);
}

export const useStreamStatus = () => useContext(Ctx).connected;

/** Bumps after each reconnect; include it in a data-loading effect's dependencies to resync. */
export const useStreamGeneration = () => useContext(Ctx).generation;
