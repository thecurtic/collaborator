import { Check, Loader2, Mic, PhoneOff, Volume2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useDebugEnabled } from '@/features/settings/uiPrefs';
import { cn } from '@/lib/utils';
import { useCall, type CallPhase } from './useCall';

interface CallScreenProps {
  open: boolean;
  onClose: () => void;
}

const LABELS: Record<CallPhase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening…',
  processing: 'Processing…',
  responding: 'Responding…',
  error: 'Call error',
};

function Turn({
  role,
  text,
  live,
}: {
  role: 'user' | 'assistant';
  text: string;
  live?: boolean;
}) {
  return (
    <div>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {role === 'user' ? 'You' : 'Assistant'}
      </p>
      <p
        className={cn(
          'whitespace-pre-wrap text-[17px] leading-relaxed',
          live ? 'text-foreground/80' : 'text-foreground',
        )}
      >
        {text}
      </p>
    </div>
  );
}

export function CallScreen({ open, onClose }: CallScreenProps) {
  const { phase, partial, response, transcript, error, logs, endTurn, end } =
    useCall(open, onClose);
  const showDebug = useDebugEnabled();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [transcript.length, partial, response]);

  if (!open) return null;

  const speaking = phase === 'responding';
  const busy = phase === 'connecting' || phase === 'processing';

  return (
    <div className="pt-safe pb-safe px-safe fixed inset-0 z-50 flex flex-col bg-background">
      {/* Status indicator — kept up top so the transcript has room below. */}
      <div className="flex flex-col items-center gap-2 border-b border-border px-4 py-4">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <span
            className={cn(
              'absolute inset-0 rounded-full',
              phase === 'listening' && 'animate-ping bg-primary/30',
              phase === 'responding' && 'animate-pulse bg-green-500/30',
              phase === 'error' && 'bg-destructive/20',
              busy && 'bg-muted',
            )}
          />
          <span
            className={cn(
              'relative flex h-12 w-12 items-center justify-center rounded-full',
              speaking
                ? 'bg-green-500/20 text-green-500'
                : phase === 'error'
                  ? 'bg-destructive/20 text-destructive'
                  : 'bg-primary/20 text-primary',
            )}
          >
            {busy ? (
              <Loader2 className="h-6 w-6 animate-spin" />
            ) : speaking ? (
              <Volume2 className="h-6 w-6" />
            ) : (
              <Mic className="h-6 w-6" />
            )}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{LABELS[phase]}</p>
      </div>

      {/* Scrollable conversation — readable while listening or speaking. */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <div className="mx-auto flex max-w-md flex-col gap-5">
          {transcript.map((t) => (
            <Turn key={t.id} role={t.role} text={t.text} />
          ))}
          {phase === 'listening' && partial && (
            <Turn role="user" text={partial} live />
          )}
          {phase === 'responding' && response && (
            <Turn role="assistant" text={response} live />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Diagnostics — toggled via Settings → Developer diagnostics. */}
      {showDebug && logs.length > 0 && (
        <div className="mx-auto max-h-32 w-full max-w-md overflow-y-auto border-t border-border bg-card p-2 font-mono text-[10px] leading-snug text-muted-foreground">
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-center gap-6 border-t border-border p-6">
        {phase === 'listening' && (
          <Button
            variant="secondary"
            onClick={endTurn}
            className="h-12 gap-2 rounded-full px-5 active:scale-95"
          >
            <Check className="h-4 w-4" />
            Done speaking
          </Button>
        )}
        <Button
          variant="destructive"
          size="icon"
          aria-label="End call"
          onClick={end}
          className="h-14 w-14 rounded-full active:scale-95"
        >
          <PhoneOff className="h-6 w-6" />
        </Button>
      </div>
    </div>
  );
}
