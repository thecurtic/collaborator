import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import type { Turn } from '@/domain/models';

const PAGE_LIMIT = 50;

interface ChatState {
  turns: Turn[];
  loading: boolean; // initial history load
  sending: boolean; // a message is in flight
  error: string | null;
  contextWindow: number | null; // size of the context window the backend reports
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function useChat() {
  const [state, setState] = useState<ChatState>({
    turns: [],
    loading: true,
    sending: false,
    error: null,
    contextWindow: null,
  });

  const loadHistory = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await api.listTurns({ limit: PAGE_LIMIT, offset: 0 });
      const turns = [...page.turns].sort((a, b) => a.id - b.id);
      setState((s) => ({
        ...s,
        turns,
        loading: false,
        contextWindow: page.contextWindow,
      }));
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errMessage(err) }));
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const sendMessage = useCallback(
    async (message: string, contextTurns?: number) => {
      const trimmed = message.trim();
      if (!trimmed) return;

      // Optimistic turns (temp negative ids) so the user's message and the
      // streaming reply appear instantly; reconciled with the server on done.
      const userTempId = -Date.now();
      const asstTempId = userTempId - 1;
      const now = new Date().toISOString();
      const tempTurn = (
        id: number,
        role: 'user' | 'assistant',
        msg: string,
        resp: string,
      ): Turn => ({
        id,
        userId: null,
        role,
        message: msg,
        response: resp,
        committed: true,
        contextTurns: 0,
        createdAt: now,
        modelName: null,
        tokenCount: null,
        tags: [],
      });

      setState((s) => ({
        ...s,
        sending: true,
        error: null,
        turns: [
          ...s.turns,
          tempTurn(userTempId, 'user', trimmed, ''),
          tempTurn(asstTempId, 'assistant', '', ''),
        ],
      }));

      try {
        // Stream tokens into the optimistic assistant turn as they arrive.
        await api.sendMessageStream({ message: trimmed, contextTurns }, (chunk) => {
          setState((s) => ({
            ...s,
            turns: s.turns.map((t) =>
              t.id === asstTempId ? { ...t, response: t.response + chunk } : t,
            ),
          }));
        });
        // Reconcile with canonical server state: real per-turn ids (needed for
        // discard) and the reported context window.
        const page = await api.listTurns({ limit: PAGE_LIMIT, offset: 0 });
        const turns = [...page.turns].sort((a, b) => a.id - b.id);
        setState((s) => ({
          ...s,
          turns,
          sending: false,
          contextWindow: page.contextWindow,
        }));
      } catch (err) {
        // Drop the optimistic turns on failure.
        setState((s) => ({
          ...s,
          sending: false,
          error: errMessage(err),
          turns: s.turns.filter(
            (t) => t.id !== userTempId && t.id !== asstTempId,
          ),
        }));
      }
    },
    [],
  );

  const discardTurn = useCallback(async (turnId: number) => {
    // Optimistic: mark uncommitted immediately, roll back on failure.
    setState((s) => ({
      ...s,
      turns: s.turns.map((t) =>
        t.id === turnId ? { ...t, committed: false } : t,
      ),
    }));
    try {
      await api.discardTurn(turnId);
    } catch (err) {
      setState((s) => ({
        ...s,
        error: errMessage(err),
        turns: s.turns.map((t) =>
          t.id === turnId ? { ...t, committed: true } : t,
        ),
      }));
    }
  }, []);

  return {
    ...state,
    sendMessage,
    discardTurn,
    reload: loadHistory,
  };
}
