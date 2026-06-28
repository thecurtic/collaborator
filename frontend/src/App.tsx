import { Loader2, Settings as SettingsIcon } from 'lucide-react';
import { useState } from 'react';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { PasskeyScreen } from '@/auth/PasskeyScreen';
import { Button } from '@/components/ui/button';
import { HealthIndicator } from '@/features/health/HealthIndicator';
import { ChatView } from '@/features/chat/ChatView';
import { SettingsSheet } from '@/features/settings/SettingsSheet';

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

function AppShell() {
  const { gate } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);

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
          <div className="flex items-center gap-1">
            <HealthIndicator />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
              className="h-8 w-8"
            >
              <SettingsIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <main className="min-h-0 flex-1">
        {gate === 'checking' ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : gate === 'locked' ? (
          <PasskeyScreen />
        ) : (
          <ChatView />
        )}
      </main>
    </div>
  );
}
