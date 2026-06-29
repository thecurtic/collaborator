import { Loader2, Phone, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { PasskeyScreen } from '@/auth/PasskeyScreen';
import { Button } from '@/components/ui/button';
import { HealthIndicator } from '@/features/health/HealthIndicator';
import { ChatView } from '@/features/chat/ChatView';
import type { BranchTarget } from '@/features/chat/branchTarget';
import { SettingsSheet } from '@/features/settings/SettingsSheet';
import { CallScreen } from '@/features/voice/CallScreen';
import { SpeechProvider } from '@/features/voice/SpeechContext';

export default function App() {
  return (
    <AuthProvider>
      <SpeechProvider>
        <AppShell />
      </SpeechProvider>
    </AuthProvider>
  );
}

function AppShell() {
  const { gate } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [chatReload, setChatReload] = useState(0);
  // A pending branch is shared so a call can fork from it too (not just typing).
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null);
  // Closing a call refreshes the chat so the spoken exchange (persisted with
  // commit:true) shows up in the text history.
  const closeCall = useCallback(() => {
    setCallOpen(false);
    setChatReload((n) => n + 1);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe px-safe border-b border-border">
        <div className="flex items-center justify-end px-4 py-3">
          <div className="flex items-center gap-1">
            <HealthIndicator />
            {gate === 'open' && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Start voice call"
                onClick={() => setCallOpen(true)}
                className="h-8 w-8"
              >
                <Phone className="h-4 w-4" />
              </Button>
            )}
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
      <CallScreen
        open={callOpen}
        onClose={closeCall}
        branchTarget={branchTarget}
        onBranchConsumed={() => setBranchTarget(null)}
      />

      <main className="min-h-0 flex-1">
        {gate === 'checking' ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : gate === 'locked' ? (
          <PasskeyScreen />
        ) : (
          <ChatView
            reloadSignal={chatReload}
            branchTarget={branchTarget}
            onBranchTargetChange={setBranchTarget}
          />
        )}
      </main>
    </div>
  );
}
