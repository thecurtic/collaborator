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
  Search,
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
import { PageBar } from '@/components/PageBar';
import { RenameSheet } from '@/components/RenameSheet';
import { ReferencesView } from '@/features/reference/ReferencesView';
import { ProfileView } from '@/features/notes/ProfileView';
import { WalletView } from '@/features/wallet/WalletView';
import { WebSearchView } from '@/features/search/WebSearchView';
import { TranscriptsView } from '@/features/transcripts/TranscriptsView';
import { ToolLogView } from '@/features/toollog/ToolLogView';
import { useLongPress } from '@/lib/useLongPress';
import { goBack, installBack, LAYER, ScreenVisible, useBack } from '@/lib/back';
import { cleanUrlsInText } from '@/lib/urlClean';
import { HealthIndicator } from '@/features/health/HealthIndicator';
import { ChatView } from '@/features/chat/ChatView';
import { CalendarView } from '@/features/calendar/CalendarView';
import { ChatCardSheet } from '@/features/chat/ChatCardSheet';
import { FeedView } from '@/features/feed/FeedView';
import { ProjectsView, type ProjectRequest } from '@/features/projects/ProjectsView';
import { RootList } from '@/features/chat/RootList';
import { ActiveFilter, ListFilterButton } from '@/components/ListFilter';
import { InferenceSwitch } from '@/features/gate/InferenceSwitch';
import { FindView } from '@/features/find/FindView';
import { ScopedResults, SearchEverywhere } from '@/features/find/ScopedSearch';
import type { FindHit, FindScope } from '@/features/find/findApi';
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

/**
 * Screens pushed over the tabs. They stack: each opens on top of whatever
 * is showing, and back returns to the one underneath with its state intact
 * (screens below the top stay mounted, hidden). A kind appears once; opening
 * it again brings it to the top.
 */
type Screen =
  | { kind: 'chat' }
  | { kind: 'notes'; lens: string | null }
  | { kind: 'transcripts'; focus: number | null; nonce: number }
  | { kind: 'find'; q: string; scope: FindScope | null; nonce: number }
  | { kind: 'webSearch' }
  | { kind: 'toolLog' }
  | { kind: 'profile' }
  | { kind: 'references' }
  | { kind: 'wallet' };

let screenNonce = 0;

function screenKey(screen: Screen): string {
  return screen.kind === 'find' || screen.kind === 'transcripts'
    ? `${screen.kind}-${screen.nonce}`
    : screen.kind === 'notes'
      ? `notes-${screen.lens ?? 'all'}`
      : screen.kind;
}

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
  // Open a project (and maybe its agent area) from elsewhere: Feed, search,
  // a notification.
  const [projectRequest, setProjectRequest] = useState<ProjectRequest | null>(null);
  // Tree map, pushed within the Conversations tab (mirrors Mind's graph).
  const [mapOpen, setMapOpen] = useState(false);
  const [chatsFilter, setChatsFilter] = useState<'all' | 'conversations'>('all');
  // The derived "no tag" filter (UX doc, Chats): rounds up loose chats.
  const [chatsTagFilter, setChatsTagFilter] = useState<'untagged' | null>(null);
  // Chats' own search bar: unified search, scoped to chats.
  const [chatsQuery, setChatsQuery] = useState('');
  // Pushed screens (chat, Notes, Transcripts, unified search, Web Search,
  // the tool log, Settings' pages), bottom first.
  const [stack, setStack] = useState<Screen[]>([]);
  const top = stack.length > 0 ? stack[stack.length - 1] : null;
  const chatOpen = top?.kind === 'chat';
  const push = useCallback((screen: Screen) => {
    setStack((prev) => [...prev.filter((s) => s.kind !== screen.kind), screen]);
  }, []);
  /** Leave the pushed screens: back to the tabs. */
  const resetScreens = useCallback(() => setStack([]), []);
  const closeScreen = useCallback((kind: Screen['kind']) => {
    setStack((prev) => prev.filter((s) => s.kind !== kind));
  }, []);
  const openChat = useCallback(() => push({ kind: 'chat' }), [push]);
  const openTranscripts = useCallback(
    (focus: number | null = null) => push({ kind: 'transcripts', focus, nonce: ++screenNonce }),
    [push],
  );
  const [scratchSearch, setScratchSearch] = useState<{ q: string; nonce: number } | null>(null);
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

  // Back (arrow, gesture, Android back button): modals and views' inner
  // levels first (they register their own), then the top pushed screen,
  // then the tree map, then a tab other than Feed goes to Feed. From Feed,
  // back leaves the app.
  useEffect(() => installBack(), []);
  useBack(stack.length > 0 || mapOpen || tab !== 'feed', () => {
    if (stack.length > 0) setStack((prev) => prev.slice(0, -1));
    else if (mapOpen) setMapOpen(false);
    else setTab('feed');
  }, LAYER.app);

  /** A bottom tab: always lands on that tab's own page. */
  const selectTab = (t: Tab) => {
    resetScreens();
    setMapOpen(false);
    setTab(t);
  };

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
        resetScreens();
        setTab('scratch');
      });
  }, [gate]);

  // Notification deep links (?open=transcript:<id>, set as the ntfy click
  // URL): open the target, then drop the param so a reload doesn't re-open.
  useEffect(() => {
    if (gate !== 'open') return;
    const sp = new URLSearchParams(window.location.search);
    const agents = /^agents:(.{1,200})$/.exec(sp.get('open') ?? '');
    if (agents) {
      window.history.replaceState(null, '', window.location.pathname);
      openAgents(agents[1], null);
      return;
    }
    const m = /^transcript:(\d+)$/.exec(sp.get('open') ?? '');
    if (!m) return;
    window.history.replaceState(null, '', window.location.pathname);
    setStack([{ kind: 'transcripts', focus: Number(m[1]), nonce: ++screenNonce }]);
  }, [gate]);

  /** Open the Notes screen, optionally on a lens. */
  const openNotes = useCallback((lens: string | null = null) => {
    // A plain open shows the list; deep links set their request after this.
    setNoteRequest(null);
    setInboxRequest(null);
    push({ kind: 'notes', lens });
  }, [push]);

  /** Open the drafts inbox (in Notes), optionally filtered to one run. */
  const openInbox = useCallback((runId: string | null) => {
    openNotes();
    setInboxRequest((prev) => ({ runId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, [openNotes]);

  /** Open a project, straight into its agent area when `agents` is set. */
  const openProject = useCallback((project: string, agents: boolean,
                                   channel: ProjectRequest['channel'] = null) => {
    setStack([]);
    setTab('projects');
    setProjectRequest((prev) => ({ project, agents, channel, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const clearProjectRequest = useCallback(() => setProjectRequest(null), []);
  const openAgents = useCallback(
    (project: string, channel: ProjectRequest['channel']) => openProject(project, true, channel),
    [openProject]);

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

  // Hanging up closes the call at once. In the background the chat catches
  // up: once a reply the hang-up cut off is saved (`saving`), the tree
  // reloads and the chat lands on the call's latest turn (a call started from
  // "New chat" would otherwise leave the user on an empty chat).
  const closeCall = useCallback((saving?: Promise<void>) => {
    setCallOpen(false);
    setCallIntro(null);
    if (introBranchRef.current) {
      introBranchRef.current = false;
      setBranchTarget(null); // never-spoken call-button fork must not linger
    }
    // Catch-all: drafts proposed in aborted voice turns never emit an event
    // the client sees — recount on hang-up so the badge can't go stale.
    void refreshDrafts();
    void (saving ?? Promise.resolve())
      .catch(() => {})
      .then(() => reload())
      .then(() => {
        const leaf = callLeafRef.current;
        callLeafRef.current = null;
        if (leaf != null) selectPathTo(leaf);
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
  const listedRoots = useMemo(() => {
    const base = chatsFilter === 'all' ? convo.tree.roots : treeRoots;
    return chatsTagFilter === 'untagged' ? base.filter((r) => r.chatTags.length === 0) : base;
  }, [chatsFilter, chatsTagFilter, convo.tree, treeRoots]);
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
    openChat();
    void api.touchFeedItem(`chat:${root.id}`); // opened = touched (warm feed)
  };

  const openFind = (q: string, scope: FindScope | null) =>
    push({ kind: 'find', q, scope, nonce: ++screenNonce });

  // A search hit → wherever that kind of thing lives, on top of the
  // results (back returns to them).
  const openFindHit = (hit: FindHit, q: string) => {
    if (hit.type === 'chat') {
      convo.selectPathTo(hit.turn_id ?? Number(hit.id));
      openChat();
    } else if (hit.type === 'note') {
      openNoteByTitle(String(hit.id));
    } else if (hit.type === 'transcript') {
      openTranscripts(Number(hit.id));
    } else if (hit.type === 'scratch') {
      resetScreens();
      setTab('scratch');
      setScratchSearch((prev) => ({ q, nonce: (prev?.nonce ?? 0) + 1 }));
    } else if (hit.type === 'agent' && hit.project) {
      openAgents(hit.project, hit.endpoint_id && hit.channel_id
        ? { endpointId: hit.endpoint_id, channel: hit.channel_id } : null);
    }
  };

  // Warm feed → wherever each kind of item lives.
  const openFeedItem = (item: FeedItem) => {
    const r = item.ref;
    if (item.type === 'chat' && r.leafId != null) {
      convo.selectPathTo(r.leafId);
      openChat();
      void api.touchFeedItem(item.key);
    } else if ((item.type === 'note' || item.type === 'event') && r.title) {
      openNoteByTitle(r.title);
    } else if (item.type === 'approval') {
      openInbox(r.runId ?? null);
    } else if (item.type === 'transcript' && r.transcriptId != null) {
      openTranscripts(r.transcriptId);
      void api.touchFeedItem(item.key);
    } else if ((item.type === 'agent_question' || item.type === 'agent_message') && r.project) {
      openAgents(r.project, r.endpointId && r.channel
        ? { endpointId: r.endpointId, channel: r.channel } : null);
    } else if (item.type === 'merged' && r.project) {
      // Merged work: go see (and try) what was built, in its project.
      void api.touchFeedItem(item.key);
      openProject(r.project, true);
    }
  };
  const openNewChat = () => {
    convo.startNewChat();
    openChat();
  };

  // From Web Search: new seed chat with the URL/query pre-drafted — the user
  // can add their question or just send (pasted URLs get auto-fetched).
  const startChatWithDraft = (text: string) => {
    convo.startNewChat();
    openChat();
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


  /** One pushed screen. Chat renders only on top (its state lives in convo). */
  const renderScreen = (screen: Screen, visible: boolean) => {
    switch (screen.kind) {
      case 'find':
        return (
          <>
            <PageBar title="Search" />
            <div className="min-h-0 flex-1">
              <FindView
                key={screen.nonce}
                initialQuery={screen.q}
                initialScope={screen.scope}
                onOpen={openFindHit}
              />
            </div>
          </>
        );
      case 'webSearch':
        return (
          <>
            <PageBar title="Web Search" />
            <div className="min-h-0 flex-1">
              <WebSearchView onStartChat={startChatWithDraft} />
            </div>
          </>
        );
      case 'references':
        return <ReferencesView />;
      case 'wallet':
        return (
          <>
            <PageBar title="Wallet" />
            <div className="min-h-0 flex-1">
              <WalletView />
            </div>
          </>
        );
      case 'profile':
        return (
          <>
            <PageBar title="Profile" />
            <div className="min-h-0 flex-1">
              <ProfileView onOpenNote={openNoteByTitle} />
            </div>
          </>
        );
      case 'notes':
        return (
          <NotesView
            pendingCount={pendingDrafts}
            inboxRequest={inboxRequest}
            noteRequest={noteRequest}
            initialLens={screen.lens}
            onBadgeRefresh={() => void refreshDrafts()}
            onSearchEverywhere={(q) => openFind(q, null)}
            roots={convo.tree.roots}
            onOpenProject={(tag) => openProject(tag, false)}
            onOpenTurn={(turnId) => {
              convo.selectPathTo(turnId);
              openChat();
            }}
          />
        );
      case 'transcripts':
        return (
          <TranscriptsView
            initialId={screen.focus}
            onSearchEverywhere={(q) => openFind(q, null)}
            onBack={goBack}
          />
        );
      case 'toolLog':
        return (
          <ToolLogView
            onOpenTurn={(turnId) => {
              convo.selectPathTo(turnId);
              openChat();
            }}
          />
        );
      case 'chat':
        if (!visible) return null;
        return (
              <ChatView
                convo={convo}
                branchTarget={branchTarget}
                onBranchTargetChange={setBranchTarget}
                onReviewDrafts={openInbox}
                onStartCall={(draft, attachments) => {
                  // A typed draft becomes the call's opening turn; attached files
                  // go with it, or alone, straight to the model.
                  setCallIntro(
                    draft || attachments?.length
                      ? { kind: 'send', text: draft ?? '', attachments }
                      : null,
                  );
                  setCallOpen(true);
                }}
                onStartCallFromTurn={(node) => {
                  // Reads this reply aloud, then listens. Tip continues in
                  // place; anything higher forks via the branch machinery.
                  if (node.id !== convo.activeLeafId) {
                    setBranchTarget({
                      turnId: node.id,
                      label: node.preview,
                    });
                    introBranchRef.current = true;
                  }
                  setCallIntro({ kind: 'speak', text: node.content });
                  setCallOpen(true);
                }}
                draftSeed={chatDraft}
                onDraftSeedConsumed={() => setChatDraft(null)}
                onConversationGone={() => closeScreen('chat')}
              />
        );
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe px-safe border-b border-border">
        <div className="flex items-center gap-2 px-2 py-3">
          {chatOpen ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back"
                onClick={() => goBack()}
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
            {top?.kind !== 'find' && gate === 'open' && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Search everything"
                title="Search chats, notes, Scratch, transcripts and files"
                onClick={() => openFind('', null)}
                className="h-9 w-9"
              >
                <Search className="h-5 w-5" />
              </Button>
            )}
            <InferenceSwitch />
            <AppMenu
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenWebSearch={() => push({ kind: 'webSearch' })}
              onOpenTranscripts={() => openTranscripts()}
              onOpenNotes={() => openNotes(null)}
              onOpenPeople={() => openNotes('social-graph')}
              onOpenToolLog={() => push({ kind: 'toolLog' })}
              onSignOut={() => {
                resetScreens();
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
        onOpenProfile={() => push({ kind: 'profile' })}
        onOpenReferences={() => push({ kind: 'references' })}
        onOpenWallet={() => push({ kind: 'wallet' })}
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
        ) : (
          <>
            <ScreenVisible.Provider value={top === null}>
              <div className={top === null ? 'h-full' : 'hidden'}>
                {tab === 'feed' ? (
                  <FeedView
                    onOpen={openFeedItem}
                    pendingDrafts={pendingDrafts}
                    onOpenInbox={() => openInbox(null)}
                  />
                ) : tab === 'projects' ? (
                  <ProjectsView
                    roots={convo.tree.roots}
                    request={projectRequest}
                    onRequestDone={clearProjectRequest}
                    onOpenNote={openNoteByTitle}
                    onOpenChat={openRoot}
                    onOpenTranscript={(id) => openTranscripts(id)}
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
                    onOpenTranscripts={() => openTranscripts()}
                    searchRequest={scratchSearch}
                    onSearchEverywhere={(q) => openFind(q, null)}
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
                      onOpenConversation={openChat}
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
                        <ListFilterButton
                          title="Show only"
                          options={[{ key: 'untagged', label: 'No tag' }]}
                          value={chatsTagFilter}
                          onChange={setChatsTagFilter}
                        />
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
                    <div className="border-b border-border px-4 py-2">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <input
                          value={chatsQuery}
                          onChange={(e) => setChatsQuery(e.target.value)}
                          placeholder="Search chats…"
                          aria-label="Search chats"
                          enterKeyHint="search"
                          className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-8 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
                        />
                        {chatsQuery && (
                          <button
                            type="button"
                            aria-label="Clear search"
                            onClick={() => setChatsQuery('')}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      <SearchEverywhere q={chatsQuery} onSearch={(q) => openFind(q, null)} />
                    </div>
                    <ActiveFilter
                      label={chatsTagFilter && !chatsQuery.trim() ? 'No tag' : null}
                      count={listedRoots.length}
                      onClear={() => setChatsTagFilter(null)}
                    />
                    {chatsQuery.trim() ? (
                      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                        <ScopedResults
                          scope="chats"
                          q={chatsQuery}
                          onOpen={(hit) => openFindHit(hit, chatsQuery.trim())}
                        />
                      </div>
                    ) : (
                    <div className="min-h-0 flex-1">
                      <RootList
                        roots={listedRoots}
                        emptyTitle={chatsTagFilter ? 'Every chat has a tag'
                          : chatsFilter === 'all' ? 'No chats yet' : 'No conversations yet'}
                        emptyHint={chatsTagFilter ? 'Nothing loose here.' : chatsFilter === 'all'
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
                    )}
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
              </div>
            </ScreenVisible.Provider>
            {stack.map((screen, i) => {
              const visible = i === stack.length - 1;
              return (
                <ScreenVisible.Provider key={screenKey(screen)} value={visible}>
                  <div className={visible ? 'flex h-full flex-col' : 'hidden'}>
                    {renderScreen(screen, visible)}
                  </div>
                </ScreenVisible.Provider>
              );
            })}
          </>
        )}
      </main>

      {/* Errors on tab screens (the chat screen shows its own strip). */}
      {top === null && gate === 'open' && convo.error && (
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

      {/* Bottom tabs: on every screen but the chat (its composer sits there).
          A tab leaves the pushed screens for that tab's page. */}
      {!chatOpen && gate === 'open' && (
        <nav className="pb-safe px-safe border-t border-border" aria-label="Main">
          <div className="mx-auto flex max-w-3xl">
            <TabButton
              icon={Flame}
              label="Feed"
              active={top === null && tab === 'feed'}
              badge={pendingDrafts}
              onClick={() => selectTab('feed')}
            />
            <TabButton
              icon={Sprout}
              label="Chats"
              active={top === null && tab === 'chats'}
              onClick={() => selectTab('chats')}
            />
            <TabButton
              icon={StickyNote}
              label="Scratch"
              active={top === null && tab === 'scratch'}
              onClick={() => selectTab('scratch')}
            />
            <TabButton
              icon={CalendarDays}
              label="Calendar"
              active={top === null && tab === 'calendar'}
              onClick={() => selectTab('calendar')}
            />
            <TabButton
              icon={FolderKanban}
              label="Projects"
              active={top === null && tab === 'projects'}
              onClick={() => selectTab('projects')}
            />
          </div>
        </nav>
      )}
    </div>
  );
}
