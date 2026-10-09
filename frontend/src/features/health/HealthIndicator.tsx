import { cn } from '@/lib/utils';
import { useHealth } from './useHealth';

export function HealthIndicator() {
  const state = useHealth();

  const { color, label, title } =
    state.status === 'online'
      ? {
          color: 'bg-green-500',
          label: 'online',
          title: `Model ${state.model || 'ready'} · backend v${state.health.version}`,
        }
      : state.status === 'model-offline'
        ? {
            // The failure that actually bites: backend fine, inference box
            // crashed. Never show green here — sends would hang/500.
            color: 'bg-amber-500',
            label: 'model offline',
            title: `Backend is up (v${state.health.version}) but the model isn't responding — check the inference machine. ${state.error}`,
          }
        : state.status === 'checking'
          ? {
              color: 'bg-yellow-500 animate-pulse',
              label: 'connecting…',
              title: 'Checking backend',
            }
          : {
              color: 'bg-destructive',
              label: 'offline',
              title: state.error,
            };

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      title={title}
    >
      <span className={cn('inline-block h-2 w-2 rounded-full', color)} />
      <span>{label}</span>
    </div>
  );
}
