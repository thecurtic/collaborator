import {
  CalendarDays,
  ChevronLeft,
  Flame,
  FolderKanban,
  Loader2,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Sprout,
  StickyNote,
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
import { ActionSheet, type SheetAction } from '@/components/ActionSheet';
import { AppMenu } from '@/components/AppMenu';
import { Button } from '@/components/ui/button';
import { RenameSheet } from '@/components/RenameSheet';
import { ReferencesView } from '@/features/reference/ReferencesView';
import { ProfileView } from '@/features/notes/ProfileView';
import { WebSearchView } from '@/features/search/WebSearchView';
import { TranscriptsView } from '@/features/transcripts/TranscriptsView';
import { useLongPress } from '@/lib/useLongPress';
import { cleanUrlsInText } from '@/lib/urlClean';
import { HealthIndicator } from '@/features/health/HealthIndicator';
import { ChatView } from '@/features/chat/ChatView';
import { CalendarView } from '@/features/calendar/CalendarView';
import { ChatCardSheet } from '@/features/chat/ChatCardSheet';
import { FeedView } from '@/features/feed/FeedView';
import { ProjectsView } from '@/features/projects/ProjectsView';
import { RootList } from '@/features/chat/RootList';
import { TreeMap } from '@/features/chat/TreeMap';
import { useConversation } from '@/features/chat/useConversation';
import type { BranchTarget } from '@/features/chat/branchTarget';
import type { CallIntro } from '@/features/chat/callIntro';
import { rootLabel, type FeedItem, type TreeNode } from '@/domain/models';
import { NotesView } from '@/features/notes/NotesView';
import { usePendingDrafts } from '@/features/notes/usePendingDrafts';
import { ScratchView } from '@/features/scratch/ScratchView';
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

/**
 * Home tabs (UX doc, Destinations): feed (default — the front door) · chats
 * (every chat; Conversations and the tree map behind a control) · scratch
 * (centre) · calendar · projects. Notes, People and Transcripts are archives
 * consulted on purpose, so they live in the menu as pushed screens.
 */
type Tab = 'feed' | 'chats' | 'scratch' | 'calendar' | 'projects';

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
        'flex flex-1 flex-col items-center gap-1 py-3 text-[11px] font-medium ' +
        (active ? 'text-primary' : 'text-muted-foreground hover:text-foreground')
      }
    >
      <span className="relative">
        <Icon className="h-6 w-6" />
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
  const { gate, signOut } = useAuth();
  const convo = useConversation(0);
  const [tab, setTab] = useState<Tab>('feed');
  // Deep link into Mind at one note (from the feed).
  const [noteRequest, setNoteRequest] = useState<{
    title: string;
    nonce: number;
  } | null>(null);
  // Tree map, pushed within the Conversations tab (mirrors Mind's graph).
  const [mapOpen, setMapOpen] = useState(false);
  const [chatsFilter, setChatsFilter] = useState<'all' | 'conversations'>('all');
  // The chat screen is "pushed" over the tabs (back arrow returns to them).
  const [chatOpen, setChatOpen] = useState(false);
  // Web Search and Transcripts push over whatever is showing; so do Profile
  // and References, which are pages of Settings.
  const [settingsPage, setSettingsPage] = useState<'profile' | 'references' | null>(null);
  // Notes (the vault: list, graph, people, drafts inbox) — a pushed
  // screen from the menu; `notesLens` opens it on a lens (People).
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesLens, setNotesLens] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [transcriptsOpen, setTranscriptsOpen] = useState(false);
  // A transcript to open straight away (from a notification's deep link).
  const [transcriptFocus, setTranscriptFocus] = useState<number | null>(null);
  // Composer prefill for chats spawned from search ("chat about this page").
  const [chatDraft, setChatDraft] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  // Tap-and-hold on the chat title → conversation actions.
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  const [titleRenameOpen, setTitleRenameOpen] = useState(false);
  // The three-dots chat card: from a list row (root) or the open chat (leaf).
  const [chatCard, setChatCard] = useState<{
    turnId: number;
    label: string;
  } | null>(null);
  // A pending branch is shared so a call can fork from it too (not just typing).
  const [branchTarget, setBranchTarget] = useState<BranchTarget | null>(null);
  // What the next call does before its first listen (typed draft / read a
  // reply). Set by the two call entry points, cleared when the call closes.
  const [callIntro, setCallIntro] = useState<CallIntro | null>(null);
  // True when the call button (not the user) set branchTarget — cleared on
  // call close so a never-consumed fork doesn't linger on the composer.
  const introBranchRef = useRef(false);
  // One backgrounded notes-synthesis run at a time (banner above the screen).
  const [synth, setSynth] = useState<SynthState | null>(null);
  const synthRunning = useRef(false);
  // Deep link into the drafts inbox (nonce re-triggers with a fresh runId).
  const [inboxRequest, setInboxRequest] = useState<{
    runId: string | null;
    nonce: number;
  } | null>(null);
  // Transient app-level feedback (e.g. title regeneration progress/result).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((message: string, ms = 4000) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current =
      ms > 0 ? setTimeout(() => setNotice(null), ms) : null;
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );
  // Latest turn id spoken in the current call — where the chat lands on close.
  const callLeafRef = useRef<number | null>(null);

  const { count: pendingDrafts, refresh: refreshDrafts } = usePendingDrafts(
    gate === 'open',
  );

  const { reload, rootOfTurn, promote, selectPathTo, setTitleLocal } = convo;

  // Model-proposed drafts land in the inbox server-side — keep the badge live.
  useEffect(() => {
    if (convo.proposedDrafts.length > 0) void refreshDrafts();
  }, [convo.proposedDrafts, refreshDrafts]);

  // Shared-in text (PWA share_target GET params / SEND intents forwarded by
  // the Android shell as ?text=&title=): capture into Scratch, then land
  // there. The URL is consumed immediately so reloads can't double-capture.
  useEffect(() => {
    if (gate !== 'open') return;
    const sp = new URLSearchParams(window.location.search);
    const shared = [sp.get('title'), sp.get('text'), sp.get('url')]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!shared) return;
    window.history.replaceState(null, '', window.location.pathname);
    void api
      .addScratch(cleanUrlsInText(shared))
      .catch(() => {}) // offline: the text is lost, but never double-posted
      .finally(() => {
        setChatOpen(false);
        setTab('scratch');
      });
  }, [gate]);

  // Notification deep links (?open=transcript:<id>, set as the ntfy click
  // URL): open the target, then drop the param so a reload doesn't re-open.
  useEffect(() => {
    if (gate !== 'open') return;
    const sp = new URLSearchParams(window.location.search);
    const m = /^transcript:(\d+)$/.exec(sp.get('open') ?? '');
    if (!m) return;
    window.history.replaceState(null, '', window.location.pathname);
    setChatOpen(false);
    setSettingsPage(null);
    setSearchOpen(false);
    setTranscriptFocus(Number(m[1]));
    setTranscriptsOpen(true);
  }, [gate]);

  /** Open the Notes screen, optionally on a lens. */
  const openNotes = useCallback((lens: string | null = null) => {
    setChatOpen(false);
    setSettingsPage(null);
    setSearchOpen(false);
    setTranscriptsOpen(false);
    setNotesLens(lens);
    setNotesOpen(true);
  }, []);

  /** Open the drafts inbox (in Notes), optionally filtered to one run. */
  const openInbox = useCallback((runId: string | null) => {
    openNotes();
    setInboxRequest((prev) => ({ runId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, [openNotes]);

  /** Open one vault note by title. */
  const openNoteByTitle = useCallback((title: string) => {
    openNotes();
    setNoteRequest((prev) => ({ title, nonce: (prev?.nonce ?? 0) + 1 }));
  }, [openNotes]);

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
  // commit:true) shows up in the text history — then lands the chat on the
  // call's conversation (a call started from "New chat" would otherwise dump
  // the user back on an empty chat instead of what they just talked about).
  const closeCall = useCallback(() => {
    const leaf = callLeafRef.current;
    callLeafRef.current = null;
    // Catch-all: drafts proposed in aborted voice turns never emit an event
    // the client sees — recount on hang-up so the badge can't go stale.
    void refreshDrafts();
    // Land the chat BEFORE lifting the call screen: reload + select while
    // still covered, so the transcript is already sitting at the bottom the
    // moment the call closes (no visible jump-then-scroll).
    void reload()
      .then(() => {
        if (leaf != null) selectPathTo(leaf);
      })
      .finally(() => {
        setCallOpen(false);
        setCallIntro(null);
        if (introBranchRef.current) {
          introBranchRef.current = false;
          setBranchTarget(null); // never-spoken call-button fork must not linger
        }
      });
  }, [reload, selectPathTo, refreshDrafts]);

  // Branching in a call is a graduation signal too (same as typed branches).
  const handleCallBranched = useCallback(
    (parentTurnId: number) => {
      const root = rootOfTurn(parentTurnId);
      if (root?.state === 'seed') void promote(root.id);
    },
    [rootOfTurn, promote],
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
  // Every tag on a chat, for the card's completion + near-miss checks.
  const chatTagVocabulary = useMemo(
    () => [...new Set(convo.tree.roots.flatMap((r) => r.chatTags))].sort(),
    [convo.tree],
  );
  const openChatCard = (root: TreeNode) =>
    setChatCard({ turnId: root.id, label: rootLabel(root) });

  const openRoot = (root: TreeNode) => {
    convo.selectPathTo(root.id); // path continues to the tip via main-line defaults
    setChatOpen(true);
    void api.touchFeedItem(`chat:${root.id}`); // opened = touched (warm feed)
  };

  // Warm feed → wherever each kind of item lives.
  const openFeedItem = (item: FeedItem) => {
    const r = item.ref;
    if (item.type === 'chat' && r.leafId != null) {
      convo.selectPathTo(r.leafId);
      setChatOpen(true);
      void api.touchFeedItem(item.key);
    } else if ((item.type === 'note' || item.type === 'event') && r.title) {
      openNoteByTitle(r.title);
    } else if (item.type === 'approval') {
      openInbox(r.runId ?? null);
    } else if (item.type === 'transcript' && r.transcriptId != null) {
      setTranscriptFocus(r.transcriptId);
      setTranscriptsOpen(true);
      void api.touchFeedItem(item.key);
    }
    // merged: its home is the project view (step 7); nothing to open yet.
  };
  const openNewChat = () => {
    convo.startNewChat();
    setChatOpen(true);
  };

  // From Web Search: new seed chat with the URL/query pre-drafted — the user
  // can add their question or just send (pasted URLs get auto-fetched).
  const startChatWithDraft = (text: string) => {
    setSearchOpen(false);
    setSettingsPage(null);
    setTranscriptsOpen(false);
    convo.startNewChat();
    setChatOpen(true);
    setChatDraft((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  // No confirm — deletes are deliberate here (hold-menu / map action).
  const handleDeleteSubtree = (turnId: number) => {
    void convo.remove(turnId, true);
  };

  const chatTitle = chatOpen
    ? activeRoot
      ? rootLabel(activeRoot)
      : 'New chat'
    : null;

  // Regenerate the LLM title, then refresh so lists/headers pick it up.
  // Generation is an LLM call (seconds on local inference) and can 502 —
  // always say what happened; silence here read as "the button does nothing".
  const regenerateTitle = useCallback(
    (rootId: number) => {
      showNotice('Regenerating title…', 0);
      void api
        .regenerateTitle(rootId)
        .then((title) => {
          // Apply the RESPONSE locally — an immediate refetch races the
          // backend's write and can clobber the list with the stale title.
          setTitleLocal(rootId, title);
          // A manual name always outranks the title (name ?? title ?? preview)
          // — surface that instead of looking like a no-op.
          const named = rootOfTurn(rootId)?.name;
          showNotice(
            named
              ? `New title "${title}" is hidden by the name "${named}" — clear the name to show it`
              : `Title: ${title}`,
          );
        })
        .catch((err: unknown) => {
          void reload();
          showNotice(
            err instanceof Error && err.message
              ? `Title generation failed: ${err.message}`
              : 'Title generation failed — the old title stands',
          );
        });
    },
    [reload, rootOfTurn, setTitleLocal, showNotice],
  );

  // Hold the chat title for conversation actions (rename/promote/synthesize).
  const titlePress = useLongPress(() => {
    if (chatOpen && activeRoot) setTitleMenuOpen(true);
  });
  const titleActions: SheetAction[] = activeRoot
    ? [
        { label: 'Rename', icon: Pencil, onSelect: () => setTitleRenameOpen(true) },
        ...(activeRoot.state === 'seed'
          ? [
              {
                label: 'Promote to conversation',
                icon: TreePine,
                onSelect: () => void convo.promote(activeRoot.id),
              },
            ]
          : []),
        {
          label: 'Synthesize notes',
          icon: NotebookPen,
          onSelect: () => startSynthesis(activeRoot.id, rootLabel(activeRoot)),
        },
        {
          label: 'Regenerate title',
          icon: RefreshCw,
          onSelect: () => regenerateTitle(activeRoot.id),
        },
      ]
    : [];

  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe px-safe border-b border-border">
        <div className="flex items-center gap-2 px-2 py-3">
          {settingsPage !== null || searchOpen || transcriptsOpen || notesOpen ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back"
                onClick={() =>
                  searchOpen
                    ? setSearchOpen(false)
                    : transcriptsOpen
                      ? setTranscriptsOpen(false)
                      : notesOpen
                        ? setNotesOpen(false)
                        : setSettingsPage(null)
                }
                className="h-8 w-8 shrink-0"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {searchOpen
                  ? 'Web Search'
                  : transcriptsOpen
                    ? 'Transcripts'
                    : notesOpen
                      ? notesLens === 'social-graph' ? 'People' : 'Notes'
                      : settingsPage === 'profile' ? 'Profile' : 'References'}
              </span>
            </>
          ) : chatOpen ? (
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
              {/* Hold for rename / promote / synthesize. */}
              <button
                type="button"
                {...titlePress}
                title="Hold for options"
                className="min-w-0 flex-1 select-none truncate text-left text-sm font-medium [-webkit-touch-callout:none]"
              >
                {chatTitle}
              </button>
              {activeRoot && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="About this chat"
                  onClick={() =>
                    setChatCard({
                      // The active leaf: the card summarizes the branch in view.
                      turnId: convo.activeLeafId ?? activeRoot.id,
                      label: rootLabel(activeRoot),
                    })
                  }
                  className="h-8 w-8 shrink-0 text-muted-foreground"
                >
                  <MoreHorizontal className="h-5 w-5" />
                </Button>
              )}
            </>
          ) : (
            <div className="flex min-w-0 flex-1 items-center px-2">
              <HealthIndicator />
            </div>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <AppMenu
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenWebSearch={() => {
                setSettingsPage(null);
                setTranscriptsOpen(false);
                setSearchOpen(true);
              }}
              onOpenTranscripts={() => {
                setSettingsPage(null);
                setSearchOpen(false);
                setNotesOpen(false);
                setTranscriptsOpen(true);
              }}
              onOpenNotes={() => openNotes(null)}
              onOpenPeople={() => openNotes('social-graph')}
              onSignOut={() => {
                setSettingsPage(null);
                setSearchOpen(false);
                setTranscriptsOpen(false);
                setChatOpen(false);
                signOut();
              }}
            />
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
        onBranchConsumed={() => {
          introBranchRef.current = false;
          setBranchTarget(null);
        }}
        onBranchCreated={handleCallBranched}
        onLeafChanged={(id) => {
          callLeafRef.current = id;
        }}
        intro={callIntro}
        onDraftsProposed={() => void refreshDrafts()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/* After CallScreen so it stacks on top when opened mid-call. */}
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onOpenProfile={() => {
          setSearchOpen(false);
          setTranscriptsOpen(false);
          setNotesOpen(false);
          setChatOpen(false);
          setSettingsPage('profile');
        }}
        onOpenReferences={() => {
          setSearchOpen(false);
          setTranscriptsOpen(false);
          setNotesOpen(false);
          setChatOpen(false);
          setSettingsPage('references');
        }}
      />

      {/* Chat-title hold menu (+ its rename sheet). */}
      <ActionSheet
        open={titleMenuOpen}
        title={chatTitle ?? undefined}
        actions={titleActions}
        onClose={() => setTitleMenuOpen(false)}
      />
      <ChatCardSheet
        open={chatCard !== null}
        turnId={chatCard?.turnId ?? null}
        label={chatCard?.label ?? ''}
        vocabulary={chatTagVocabulary}
        onTagsSaved={convo.setChatTagsLocal}
        onClose={() => setChatCard(null)}
      />
      <RenameSheet
        open={titleRenameOpen}
        initial={activeRoot?.name ?? ''}
        onSave={(name) => {
          if (activeRoot) void convo.renameTurn(activeRoot.id, name);
        }}
        onClose={() => setTitleRenameOpen(false)}
      />

      <main className="min-h-0 flex-1">
        {gate === 'checking' ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : gate === 'locked' ? (
          <PasskeyScreen />
        ) : searchOpen ? (
          <WebSearchView onStartChat={startChatWithDraft} />
        ) : settingsPage === 'references' ? (
          <ReferencesView />
        ) : settingsPage === 'profile' ? (
          <ProfileView onOpenNote={(title) => {
            setSettingsPage(null);
            openNoteByTitle(title);
          }} />
        ) : notesOpen ? (
          <NotesView
            key={notesLens ?? 'notes'}
            pendingCount={pendingDrafts}
            inboxRequest={inboxRequest}
            noteRequest={noteRequest}
            initialLens={notesLens}
            onBadgeRefresh={() => void refreshDrafts()}
            onOpenTurn={(turnId) => {
              setNotesOpen(false);
              convo.selectPathTo(turnId);
              setChatOpen(true);
            }}
          />
        ) : transcriptsOpen ? (
          <TranscriptsView
            initialId={transcriptFocus}
            onBack={() => {
              setTranscriptsOpen(false);
              setTranscriptFocus(null);
            }}
          />
        ) : chatOpen ? (
          <ChatView
            convo={convo}
            branchTarget={branchTarget}
            onBranchTargetChange={setBranchTarget}
            onReviewDrafts={openInbox}
            onStartCall={(draft) => {
              // A typed draft becomes the call's opening turn.
              setCallIntro(draft ? { kind: 'send', text: draft } : null);
              setCallOpen(true);
            }}
            onStartCallFromTurn={(node) => {
              // Reads this reply aloud, then listens. Tip continues in
              // place; anything higher forks via the branch machinery.
              if (node.id !== convo.activeLeafId) {
                setBranchTarget({
                  turnId: node.id,
                  label: node.preview,
                  withContext: true,
                });
                introBranchRef.current = true;
              }
              setCallIntro({ kind: 'speak', text: node.content });
              setCallOpen(true);
            }}
            draftSeed={chatDraft}
            onDraftSeedConsumed={() => setChatDraft(null)}
            onConversationGone={() => setChatOpen(false)}
          />
        ) : tab === 'feed' ? (
          <FeedView
            onOpen={openFeedItem}
            pendingDrafts={pendingDrafts}
            onOpenInbox={() => openInbox(null)}
          />
        ) : tab === 'projects' ? (
          <ProjectsView
            roots={convo.tree.roots}
            onOpenNote={openNoteByTitle}
            onOpenChat={openRoot}
            onOpenTranscript={(id) => {
              setTranscriptFocus(id);
              setTranscriptsOpen(true);
            }}
          />
        ) : convo.loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : tab === 'calendar' ? (
          <CalendarView
            onOpenNote={openNoteByTitle}
            onReviewImport={(runId) => openInbox(runId)}
          />
        ) : tab === 'scratch' ? (
          <ScratchView
            onStartChat={startChatWithDraft}
            onOpenTranscripts={() => setTranscriptsOpen(true)}
          />
        ) : mapOpen ? (
          // The tree map, pushed within Chats (like Mind's Graph View).
          <div className="relative h-full">
            <TreeMap
              tree={mapTree}
              activeIds={convo.activeIds}
              onSelect={convo.selectPathTo}
              onDeleteSubtree={handleDeleteSubtree}
              onRename={(id, name) => void convo.renameTurn(id, name)}
              onOpenConversation={() => setChatOpen(true)}
              onSynthesize={startSynthesis}
            />
            <Button
              variant="secondary"
              size="icon"
              aria-label="Back to chats"
              onClick={() => setMapOpen(false)}
              className="absolute left-3 top-3 z-10 h-9 w-9 rounded-full shadow-md"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
          </div>
        ) : (
          // Chats (UX doc): every chat, seeds included; the promoted ones are
          // also reachable as Conversations, behind the control here.
          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <h2 className="text-2xl font-semibold">Chats</h2>
              <div className="flex items-center gap-1">
                <div className="flex rounded-md border border-border p-0.5">
                  {(['all', 'conversations'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setChatsFilter(f)}
                      className={
                        'rounded px-2 py-1 text-xs capitalize ' +
                        (chatsFilter === f
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:text-foreground')
                      }
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Tree map"
                  title="Tree map — every conversation as a metro line"
                  onClick={() => setMapOpen(true)}
                  className="h-8 w-8 text-muted-foreground"
                >
                  <TreePine className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <RootList
                roots={chatsFilter === 'all' ? convo.tree.roots : treeRoots}
                emptyTitle={chatsFilter === 'all' ? 'No chats yet' : 'No conversations yet'}
                emptyHint={chatsFilter === 'all'
                  ? 'Start one — it stays a seed until you name, tag, branch or synthesize it.'
                  : 'A chat becomes a conversation when you name, tag, branch or synthesize it.'}
                onOpen={openRoot}
                onRename={(id, name) => void convo.renameTurn(id, name)}
                onPromote={(id) => void convo.promote(id)}
                onSynthesize={startSynthesis}
                onRegenerateTitle={regenerateTitle}
                onDelete={handleDeleteSubtree}
                onOpenCard={openChatCard}
              />
            </div>
            {/* Floating pill, sitting just above the tab bar. */}
            <Button
              onClick={openNewChat}
              className="absolute bottom-4 right-4 h-12 gap-2 rounded-full px-5 shadow-lg"
            >
              <Plus className="h-5 w-5" />
              New chat
            </Button>
          </div>
        )}
      </main>

      {/* Errors on tab screens (the chat screen shows its own strip). */}
      {!chatOpen && settingsPage === null && !searchOpen && !transcriptsOpen && !notesOpen && gate === 'open' && convo.error && (
        <div className="flex items-start gap-2 border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <p className="max-h-24 min-w-0 flex-1 overflow-y-auto break-words">
            {convo.error}
          </p>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={convo.clearError}
            className="shrink-0 rounded p-1 hover:bg-destructive/10 active:scale-90"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Transient feedback (title regeneration etc.) — any screen. */}
      {gate === 'open' && notice && (
        <div className="border-t border-border bg-muted/60 px-4 py-2 text-center text-sm text-muted-foreground">
          {notice}
        </div>
      )}

      {/* Bottom tabs — hidden while a pushed screen (chat/references/search) is open. */}
      {!chatOpen && settingsPage === null && !searchOpen && !transcriptsOpen && !notesOpen && gate === 'open' && (
        <nav className="pb-safe px-safe border-t border-border" aria-label="Main">
          <div className="mx-auto flex max-w-3xl">
            <TabButton
              icon={Flame}
              label="Feed"
              active={tab === 'feed'}
              badge={pendingDrafts}
              onClick={() => setTab('feed')}
            />
            <TabButton
              icon={Sprout}
              label="Chats"
              active={tab === 'chats'}
              onClick={() => setTab('chats')}
            />
            <TabButton
              icon={StickyNote}
              label="Scratch"
              active={tab === 'scratch'}
              onClick={() => setTab('scratch')}
            />
            <TabButton
              icon={CalendarDays}
              label="Calendar"
              active={tab === 'calendar'}
              onClick={() => setTab('calendar')}
            />
            <TabButton
              icon={FolderKanban}
              label="Projects"
              active={tab === 'projects'}
              onClick={() => setTab('projects')}
            />
          </div>
        </nav>
      )}
    </div>
  );
}
