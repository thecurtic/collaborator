import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import type { Turn } from '@/domain/models';

const PAGE_LIMIT = 50;

interface ChatState {
  turns: Turn[];
  loading: boolean; // initial history load
  sending: boolean; // a message is in flight
  error: string | null;
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
  });

  const loadHistory = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await api.listTurns({ limit: PAGE_LIMIT, offset: 0 });
      const turns = [...page.turns].sort((a, b) => a.id - b.id);
      setState((s) => ({ ...s, turns, loading: false }));
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

      setState((s) => ({ ...s, sending: true, error: null }));
      try {
        await api.sendMessage({ message: trimmed, contextTurns });
        // Re-fetch canonical state: POST returns a single combined object, so
        // reloading is the reliable way to get real per-turn ids (needed for
        // discard) and any server-side normalization.
        const page = await api.listTurns({ limit: PAGE_LIMIT, offset: 0 });
        const turns = [...page.turns].sort((a, b) => a.id - b.id);
        setState((s) => ({ ...s, turns, sending: false }));
      } catch (err) {
        setState((s) => ({ ...s, sending: false, error: errMessage(err) }));
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
