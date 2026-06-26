import { cn } from '@/lib/utils';
import { useHealth } from './useHealth';

export function HealthIndicator() {
  const state = useHealth();

  const { color, label, title } =
    state.status === 'online'
      ? {
          color: 'bg-green-500',
          label: `online · v${state.health.version}`,
          title: `Backend healthy (${state.health.status})`,
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
