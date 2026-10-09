import { KeyRound, Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from './AuthContext';

export function PasskeyScreen() {
  const { submitPasskey } = useAuth();
  const [passkey, setPasskey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = passkey.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError('');
    const result = await submitPasskey(trimmed);
    if (!result.ok) {
      setError(result.error);
      setPasskey('');
      setBusy(false);
    }
    // On success the gate flips to "open" and this screen unmounts.
  }

  return (
    <div className="flex h-full items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-lg"
      >
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <div className="rounded-full bg-primary/15 p-3">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">Enter your passkey</h2>
          <p className="text-sm text-muted-foreground">
            Your passkey unlocks your private conversation history.
          </p>
        </div>

        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={passkey}
          onChange={(e) => setPasskey(e.target.value)}
          placeholder="Passkey"
          // 16px text avoids iOS focus-zoom; comfortable touch target.
          className="w-full rounded-xl border border-input bg-background px-3.5 py-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />

        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

        <Button
          type="submit"
          disabled={busy || !passkey.trim()}
          className="mt-4 h-11 w-full"
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying…
            </>
          ) : (
            'Unlock'
          )}
        </Button>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          No passkey? Ask your admin to generate one for you.
        </p>
      </form>
    </div>
  );
}
