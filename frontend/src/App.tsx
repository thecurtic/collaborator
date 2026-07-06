import {
  ChevronLeft,
  List,
  Loader2,
  NotebookPen,
  NotebookText,
  Phone,
  Plus,
  Settings as SettingsIcon,
  Sprout,
  TreePine,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';
import { api } from '@/api/collaborator';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { PasskeyScreen } from '@/auth/PasskeyScreen';
import { Button } from '@/components/ui/button';
import { HealthIndicator } from '@/features/health/HealthIndicator';
import { ChatView } from '@/features/chat/ChatView';
import { RootList } from '@/features/chat/RootList';
import { TreeMap } from '@/features/chat/TreeMap';
import { useConversation } from '@/features/chat/useConversation';
import type { BranchTarget } from '@/features/chat/branchTarget';
import type { TreeNode } from '@/domain/models';
import { NotesView } from '@/features/notes/NotesView';
import { usePendingDrafts } from '@/features/notes/usePendingDrafts';
import { SettingsSheet } from '@/features/settings/SettingsSheet';
import { CallScreen } from '@/features/voice/CallScreen';
import { SpeechProvider } from '@/features/voice/SpeechContext';
import { holdPwaUpdates } from '@/pwa';

export default function App() {
  return (
    <AuthProvider>
      <SpeechProvider>
        <AppShell />
      </SpeechProvider>
    </AuthProvider>
  );
}

/** Home tabs: conversation list (default) · tree map · chats (seeds) · notes. */
type Tab = 'conversations' | 'map' | 'chats' | 'notes';

/** One backgrounded synthesis run (at most one at a time). */
interface SynthState {
  treeId: number;
  label: string;
  status: 'running' | 'done' | 'error';
  runId?: string;
  count?: number;
  error?: string;
}

function TabButton({
  icon: Icon,
  label,
  active,
  badge = 0,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={badge > 0 ? `${label} (${badge} pending)` : label}
      aria-current={active ? 'page' : undefined}
      className={
        'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ' +
        (active ? 'text-primary' : 'text-muted-foreground hover:text-foreground')
      }
    >
      <span className="relative">
        <Icon className="h-5 w-5" />
        {badge > 0 && (
          <span className="absolute -right-2.5 -top-1 rounded-full bg-primary px-1 text-[9px] font-semibold leading-[14px] text-primary-foreground">
            {badge}
          </span>
        )}
      </span>
      {label}
    </button>
  );
}

function AppShell() {
  const { gate } = useAuth();
  const convo = useConversation(0);
  const [tab, setTab] = useState<Tab>('conversations');
  // The chat screen is "pushed" over the tabs (back arrow returns to them).
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  // A pending branch is shared so a call can fork from it too (not just typing).
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null);
  // One backgrounded notes-synthesis run at a time (banner above the screen).
  const [synth, setSynth] = useState<SynthState | null>(null);
  const synthRunning = useRef(false);
  // Deep link into the drafts inbox (nonce re-triggers with a fresh runId).
  const [inboxRequest, setInboxRequest] = useState<{
    runId: string | null;
    nonce: number;
  } | null>(null);

  const { count: pendingDrafts, refresh: refreshDrafts } = usePendingDrafts(
    gate === 'open',
  );

  const { reload, rootOfTurn, promote } = convo;

  // Model-proposed drafts land in the inbox server-side — keep the badge live.
  useEffect(() => {
    if (convo.proposedDrafts.length > 0) void refreshDrafts();
  }, [convo.proposedDrafts, refreshDrafts]);

  /** Open the Notes tab on the inbox, optionally filtered to one run. */
  const openInbox = useCallback((runId: string | null) => {
    setChatOpen(false);
    setTab('notes');
    setInboxRequest((prev) => ({ runId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /** Kick off a synthesis run in the background (it can take minutes). */
  const startSynthesis = useCallback(
    (treeId: number, label: string) => {
      if (synthRunning.current) return; // one at a time
      synthRunning.current = true;
      setSynth({ treeId, label, status: 'running' });
      const release = holdPwaUpdates(); // don't let an app update kill the run
      api
        .synthesizeNotes(treeId)
        .then((res) => {
          setSynth({
            treeId,
            label,
            status: 'done',
            runId: res.runId,
            count: res.count,
          });
          void refreshDrafts();
        })
        .catch((err) => {
          setSynth({
            treeId,
            label,
            status: 'error',
            error: err instanceof Error ? err.message : 'Synthesis failed',
          });
        })
        .finally(() => {
          synthRunning.current = false;
          release();
        });
    },
    [refreshDrafts],
  );

  // Closing a call refreshes the tree so the spoken exchange (persisted with
  // commit:true) shows up in the text history.
  const closeCall = useCallback(() => {
    setCallOpen(false);
    void reload();
  }, [reload]);

  // Branching in a call is a graduation signal too (same as typed branches).
  const handleCallBranched = useCallback(
    (parentTurnId: number) => {
      const root = rootOfTurn(parentTurnId);
      if (root?.state === 'seed') void promote(root.id);
    },
    [rootOfTurn, promote],
  );

  const seedRoots = useMemo(
    () => convo.tree.roots.filter((r) => r.state === 'seed'),
    [convo.tree],
  );
  const treeRoots = useMemo(
    () => convo.tree.roots.filter((r) => r.state !== 'seed'),
    [convo.tree],
  );
  // The map draws promoted conversations only (seeds live in the Chats tab).
  const mapTree = useMemo(
    () => ({ ...convo.tree, roots: treeRoots }),
    [convo.tree, treeRoots],
  );

  const activeRoot = convo.path[0]?.node ?? null;

  const openRoot = (root: TreeNode) => {
    convo.selectPathTo(root.id); // path continues to the tip via main-line defaults
    setChatOpen(true);
  };
  const openNewChat = () => {
    convo.startNewChat();
    setChatOpen(true);
  };

  const handleDeleteSubtree = (turnId: number) => {
    if (
      window.confirm('Delete this branch and all its replies? This is permanent.')
    ) {
      void convo.remove(turnId, true);
    }
  };

  const chatTitle = chatOpen
    ? activeRoot
      ? (activeRoot.name ?? activeRoot.preview ?? 'Conversation')
      : 'New chat'
    : null;

  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe px-safe border-b border-border">
        <div className="flex items-center gap-2 px-2 py-2">
          {chatOpen ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back"
                onClick={() => setChatOpen(false)}
                className="h-8 w-8 shrink-0"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              {activeRoot?.state === 'seed' && (
                <Sprout className="h-4 w-4 shrink-0 text-primary/70" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {chatTitle}
              </span>
              {activeRoot?.state === 'seed' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void convo.promote(activeRoot.id)}
                  title="Promote to a full conversation"
                  className="h-8 shrink-0 gap-1.5 px-2.5 text-primary"
                >
                  <TreePine className="h-4 w-4" />
                  Promote
                </Button>
              )}
              {activeRoot && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Synthesize notes from this conversation"
                  title="Synthesize notes from this conversation"
                  onClick={() =>
                    startSynthesis(
                      activeRoot.id,
                      activeRoot.name ?? activeRoot.preview ?? 'this chat',
                    )
                  }
                  className="h-8 w-8 shrink-0"
                >
                  <NotebookPen className="h-4 w-4" />
                </Button>
              )}
            </>
          ) : (
            <div className="flex min-w-0 flex-1 items-center px-2">
              <HealthIndicator />
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1">
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

      {/* Notes-synthesis progress/result banner (the run is backgrounded). */}
      {synth && (
        <div
          className={
            'flex items-center gap-2 border-b px-4 py-2 text-sm ' +
            (synth.status === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-primary/30 bg-primary/5 text-foreground')
          }
        >
          {synth.status === 'running' ? (
            <>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              <span className="min-w-0 flex-1 truncate">
                Synthesizing notes from “{synth.label}”… this can take a while.
              </span>
            </>
          ) : synth.status === 'done' ? (
            <>
              <NotebookPen className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate">
                {synth.count
                  ? `${synth.count} draft${synth.count === 1 ? '' : 's'} ready from “${synth.label}”`
                  : `No notes came out of “${synth.label}” — nothing passed the idea gates.`}
              </span>
              {synth.count ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    openInbox(synth.runId ?? null);
                    setSynth(null);
                  }}
                  className="h-7 shrink-0 px-2 text-primary"
                >
                  Review
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate">
                Synthesis failed: {synth.error}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startSynthesis(synth.treeId, synth.label)}
                className="h-7 shrink-0 px-2"
              >
                Retry
              </Button>
            </>
          )}
          {synth.status !== 'running' && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss"
              onClick={() => setSynth(null)}
              className="h-7 w-7 shrink-0"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}

      <CallScreen
        open={callOpen}
        onClose={closeCall}
        branchTarget={branchTarget}
        activeLeafId={convo.activeLeafId}
        onBranchConsumed={() => setBranchTarget(null)}
        onBranchCreated={handleCallBranched}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/* After CallScreen so it stacks on top when opened mid-call. */}
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <main className="min-h-0 flex-1">
        {gate === 'checking' ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : gate === 'locked' ? (
          <PasskeyScreen />
        ) : chatOpen ? (
          <ChatView
            convo={convo}
            branchTarget={branchTarget}
            onBranchTargetChange={setBranchTarget}
            onReviewDrafts={openInbox}
          />
        ) : tab === 'notes' ? (
          <NotesView
            pendingCount={pendingDrafts}
            inboxRequest={inboxRequest}
            onBadgeRefresh={() => void refreshDrafts()}
            onOpenTurn={(turnId) => {
              convo.selectPathTo(turnId);
              setChatOpen(true);
            }}
          />
        ) : convo.loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : tab === 'conversations' ? (
          <RootList
            roots={treeRoots}
            emptyTitle="No conversations yet"
            emptyHint="Chats graduate here when you promote them (or branch from them)."
            onOpen={openRoot}
            onRename={(id, name) => void convo.renameTurn(id, name)}
            onSynthesize={startSynthesis}
          />
        ) : tab === 'map' ? (
          <TreeMap
            tree={mapTree}
            activeIds={convo.activeIds}
            onSelect={convo.selectPathTo}
            onDeleteSubtree={handleDeleteSubtree}
            onRename={(id, name) => void convo.renameTurn(id, name)}
            onOpenConversation={() => setChatOpen(true)}
            onSynthesize={startSynthesis}
          />
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <h2 className="text-sm font-semibold">Chats</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={openNewChat}
                className="h-8 gap-1.5 px-2.5 text-primary"
              >
                <Plus className="h-4 w-4" />
                New chat
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              <RootList
                roots={seedRoots}
                emptyTitle="No chats yet"
                emptyHint="Start one — it stays here as a seed until it's worth keeping."
                onOpen={openRoot}
                onRename={(id, name) => void convo.renameTurn(id, name)}
                onPromote={(id) => void convo.promote(id)}
              />
            </div>
          </div>
        )}
      </main>

      {/* Errors on tab screens (the chat screen shows its own strip). */}
      {!chatOpen && gate === 'open' && convo.error && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive">
          {convo.error}
        </div>
      )}

      {/* Bottom tabs — hidden while a chat is open (the composer lives there). */}
      {!chatOpen && gate === 'open' && (
        <nav className="pb-safe px-safe border-t border-border" aria-label="Main">
          <div className="mx-auto flex max-w-3xl">
            <TabButton
              icon={List}
              label="Conversations"
              active={tab === 'conversations'}
              onClick={() => setTab('conversations')}
            />
            <TabButton
              icon={TreePine}
              label="Map"
              active={tab === 'map'}
              onClick={() => setTab('map')}
            />
            <TabButton
              icon={Sprout}
              label="Chats"
              active={tab === 'chats'}
              onClick={() => setTab('chats')}
            />
            <TabButton
              icon={NotebookText}
              label="Notes"
              active={tab === 'notes'}
              badge={pendingDrafts}
              onClick={() => setTab('notes')}
            />
          </div>
        </nav>
      )}
    </div>
  );
}
