import { Check, Loader2, Mic, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCall, type CallPhase } from './useCall';

interface CallScreenProps {
  open: boolean;
  onClose: () => void;
}

const LABELS: Record<CallPhase, string> = {
  connecting: 'Connecting…',
  listening: 'Listening…',
  responding: 'Collaborator is responding…',
  error: 'Call error',
};

export function CallScreen({ open, onClose }: CallScreenProps) {
  const { phase, partial, response, error, logs, endTurn, end } = useCall(
    open,
    onClose,
  );

  if (!open) return null;

  return (
    <div className="pt-safe pb-safe px-safe fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-hidden px-6 text-center">
        {/* State orb */}
        <div className="relative flex h-28 w-28 items-center justify-center">
          <span
            className={cn(
              'absolute inset-0 rounded-full',
              phase === 'listening' && 'animate-ping bg-primary/30',
              phase === 'responding' && 'animate-pulse bg-green-500/30',
              phase === 'error' && 'bg-destructive/20',
              phase === 'connecting' && 'bg-muted',
            )}
          />
          <span
            className={cn(
              'relative flex h-20 w-20 items-center justify-center rounded-full',
              phase === 'responding'
                ? 'bg-green-500/20 text-green-400'
                : phase === 'error'
                  ? 'bg-destructive/20 text-destructive'
                  : 'bg-primary/20 text-primary',
            )}
          >
            {phase === 'connecting' ? (
              <Loader2 className="h-7 w-7 animate-spin" />
            ) : (
              <Mic className="h-7 w-7" />
            )}
          </span>
        </div>

        <p className="text-sm text-muted-foreground">{LABELS[phase]}</p>

        {partial && (
          <p className="max-w-md text-lg font-medium leading-snug text-foreground">
            “{partial}”
          </p>
        )}

        {response && (
          <p className="max-h-48 max-w-md overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {response}
          </p>
        )}

        {error && <p className="max-w-md text-sm text-destructive">{error}</p>}
      </div>

      {/* Temporary diagnostics — remove once call mode is confirmed working. */}
      {logs.length > 0 && (
        <div className="mx-auto max-h-40 w-full max-w-md overflow-y-auto rounded-md border border-border bg-card p-2 font-mono text-[10px] leading-snug text-muted-foreground">
          {logs.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-center gap-6 p-6">
        {phase === 'listening' && (
          <Button
            variant="secondary"
            onClick={endTurn}
            className="h-12 gap-2 rounded-full px-5"
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
          className="h-14 w-14 rounded-full"
        >
          <PhoneOff className="h-6 w-6" />
        </Button>
      </div>
    </div>
  );
}
