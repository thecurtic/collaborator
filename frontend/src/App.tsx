import { HealthIndicator } from '@/features/health/HealthIndicator';
import { ChatView } from '@/features/chat/ChatView';

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe px-safe border-b border-border">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-semibold tracking-tight sm:text-lg">
              Collaborator
            </h1>
            {/* Tagline is noise on a small screen — show it from sm up. */}
            <span className="hidden text-xs text-muted-foreground sm:inline">
              visible · editable memory
            </span>
          </div>
          <HealthIndicator />
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <ChatView />
      </main>
    </div>
  );
}
