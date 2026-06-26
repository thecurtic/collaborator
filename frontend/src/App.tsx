import { HealthIndicator } from '@/features/health/HealthIndicator';
import { ChatView } from '@/features/chat/ChatView';

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold tracking-tight">Collaborator</h1>
          <span className="text-xs text-muted-foreground">
            visible · editable memory
          </span>
        </div>
        <HealthIndicator />
      </header>

      <main className="min-h-0 flex-1">
        <ChatView />
      </main>
    </div>
  );
}
