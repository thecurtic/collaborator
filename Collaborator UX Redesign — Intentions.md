# Collaborator UX Redesign — Intentions

Sep 27, 2026 · @Curtis

## Framing

Collaborator is now a tool for shaping emergence: I design the conditions, and outcomes come out of them. It has moved through three identities:

1. **Chat app** — a conversation partner.
2. **Extended cognition** — a place to think with Collaborator.
3. **Fertile ground / shaping emergence** — things get created and placed, grouped by association rather than filed into many object types.

What it's turning into is a self-sovereign personal AI hub: one place for an individual's own AI, running on local inference over their own chats, notes, people, events and transcripts, where nothing leaves unless they send it. It's meant to be open source and runnable by anyone willing to set it up. Documentation and housekeeping should reflect this.

Building software with an agent team is one significant part of that, not the whole of it, and it isn't built or tested yet. Where it applies, it's intent-driven development, past spec-driven. A spec is a contract written once; an intent is something I hold and keep steering. The engineer drives the spec, deriving it from my intent, so my job stays at the intent layer. That doesn't mean I don't want to ever see specs, it's just the main space I occupy.

When building, three things a human still needs to know: is it working, is it doing what I meant, and what did it cost. Only the middle one needs me. But monitoring alone removes the creation element, so the app leads with creating and steering intentions, with health and cost kept ambient.

This is a user-experience overhaul, not a frontend one. It covers both repos: most of what's described here needs backend work to exist at all, and the backend is as much in scope as the screens. The document is here to say what changes and what stays the same; it isn't a feature inventory, and something that already works and isn't changing may not be mentioned.

## Tags, types and frontmatter

Tags are how things get organized, and they're the one mechanism the whole app shares. Chats wear them, and so does everything in the note graph: notes, events, people, and whatever types come later. Tags identify what an entry is associated with and where it surfaces; projects are one case of that, covered under Projects.

- Frontmatter is reconsidered, not removed. It carries a type's own fields (events have dates, contacts have details), not project membership, which tags already carry. Two independent tests: a native shape earns a destination, and real fields earn frontmatter. Projects pass the first and not the second.
- Type and frontmatter come together or not at all. A tag that earns a type earns frontmatter; nothing else has any. Event, social-graph (people) and user-profile qualify; those are the tag names as they exist in the code today. Goal, question, decision and memory don't: they never proved worth a separate view, so they become ordinary tags I can put on a note, with no type, no fields, no `state`, no page of their own and no lens in Mind. Their existing frontmatter is removed, not just hidden.
- Tag hygiene is prevention only, for now, and it's already built. Because projects are emergent, a typo silently forks one: half the notes wear the right name, half wear the near-miss, and the project view quietly shows less than exists. So tagging suggests existing tags as I type, and a new tag that's a near-miss of an existing one (a case or plural difference, or up to two characters off on a tag of five or more) asks whether I meant that instead. Most typos die there.
- Repair (renaming a tag everywhere, merging two into one, retiring one) is deliberately deferred. It isn't a problem yet, and building it before it is would be building for a mess I don't have.

## Destinations

The bottom bar holds five destinations, left to right: Feed, Chats, Scratch, Events, Projects. They must be reachable most of the time (call/voice mode is one exception), and that persistence is what the bar is for. Scratch sits in the center and looks different from the other four, because it's the one I reach for fastest.

- Mind stops being a place. The hamburger menu stays and ends up holding the archives I consult rarely and on purpose (Notes, People, Transcripts) alongside what's already there: Web Search, Settings and Sign out. References moves into settings, next to Profile, since it's about what the model is being shown rather than something I browse.
- An entry's type is derived from its tags. Some tags, like event, social-graph (people) or user-profile, mean "this one gets different frontmatter": they set its type, which decides its fields and what its own page looks like. Every other tag decides where it lives and what it's associated with. The kind tags inside projects, like bug and feature, don't set a type; they're covered under Projects.
- A type earns a destination only when it has a native shape that isn't a list. Events are a calendar, so they get a tab. People are a directory, but one I consult rather than land in, so it sits in the hamburger menu. Goals, questions, decisions and memories are plain tags with no type and no destination; they surface through chats, search and association.
- Notes, in the hamburger menu, goes straight to the whole pile: the list of notes and the graph itself, with a selector to sort by date or other means.
- Mind's lenses are accounted for individually rather than as a place. People goes to the hamburger menu, Notes and the graph with it, Projects and Events to the bottom bar, and the drafts inbox into the Feed. Profile moves into settings: it's mine, edited rarely, not browsed. Goals, decisions, questions and memories keep no lens at all.
- Nothing floats over every screen. A permanent capture bubble is clutter in the PM channel or a review.
- **The inference switch is on every screen.** It lives in the top bar next to the hamburger menu, separate from the bottom bar. It toggles local inference between serving Collaborator only and serving all requests (a separate script proxies the port on the Mac). It's a pill-shaped switch with a round knob that slides to one end and the current state written inside it on the other side, so the setting reads at a glance rather than from knob position alone. The pill is red while set to Collaborator only. It's also the switch the Notifications section refers to, so stops caused by flipping it don't notify.

### Feed

Opening the app shows a single feed ordered by warmth, not a list of conversations. Warmth covers both what I was just doing and what moved while I was away.

- The feed mixes recent chats, notes I touched, upcoming events, unread or recent pi-session-manager channel entries, and pending approvals.
- Tapping an item opens that object or navigates to the appropriate destination (possible second tap).&#32;
- Arrivals from the agent team that block production come as push notifications and persist until they are no longer blocking. non-blocking items may appear in the project area.
- Branching conversations leave the front door. Branching stays as a chat-level feature, not an organizing concept.
- Agent handoff chatter does not go into the warm feed; it would bury what actually needs me.
- Pinning is necessary: some things stay at the top of the feed regardless of warmth.

### Chats

- A list of chats, pinned at the top and the rest by recency. Same behaviour as Scratch, so it's learned once.
- Each row shows the chat's title, its tags if it has any, and its last line, which is usually what I'd recognise it by. An untagged chat visibly lacks a tag, so it reads as loose rather than lost. This list is exhaustive, so an untagged chat is always findable here; a derived "no tag" filter, like Scratch's, rounds them up on purpose. The same holds for Notes in the hamburger menu.
- The floating new-chat button appears here and only here. But holding down on the "chat" destination button on the bottom bar should also spawn a new chat.
- Seeds and conversations stay distinct for now. Today a chat starts as a provisional seed and gets promoted into Conversations once it's worth keeping; that survives, but Conversations stops being a destination of its own. The Chats tab shows seeds, and promoted conversations sit inside the Chats area, out of the main list, reached from a control in the top bar next to the hamburger menu while I'm in Chats. This is provisional; I haven't settled what I want from the distinction yet.
- Chats already carry tags in the backend; there's just no surface for them. Each chat in the list gets a three-dots control on its right. Tapping it opens a card about that chat: a short summary generated on demand by a small model, plus the chat's tags, viewable and editable there. Generating the summary also proposes tags; that is the only time chat tags are proposed, and otherwise they're set by hand. The same three dots sit in the top bar while I'm inside a chat and open the same card. Tag storage exists; the card is the missing piece.

### Scratch

Scratch is Note to Self, like Signal: a chat-like screen where anything gets dumped, whether it's something to remember, a link sent to myself for later, or a YouTube link to transcribe. Mostly it's a transport, the cross-device inbox where things land to be picked up on another device or processed. It has its own shape, a stream, and things arrive in it on their own. It reads like a chat: newest at the bottom, nearest the composer, not at the top as it is today. It sits at the center of the bar and is visually distinct, for quick access.

- Scratch is for activity, not retrieval, and it holds two kinds of item. Events have a lifecycle and clear themselves: a YouTube link sent for transcription moves through sent, transcribing and transcribed, the notification fires at transcribed, and then it leaves Scratch. I don't wait on the screen, since a transcript takes minutes, and I often don't open it at all; I ask the LLM to find it so we can talk about it. Transmissions (links, photos, documents, text sent between devices) have no completion, and some need to stay forever.
- The list is transmissions minus completed events. I can pin as many as I want at the top; the rest sit below by recency.
- No manual categories. Filtering is derived from what each item already is (links, photos, documents, text, voice), so anything new arrives already sorted. The filter stays quiet, a control I reach for once the list has grown rather than a row of chips always on screen.
- Each item renders as what it is, the same principle as the feed's object shapes. A link shows the page title and favicon, not the URL. A photo shows the photo. A document shows its filename and type. A YouTube transcription in flight shows the video's title and thumbnail plus its state, so the stream reads as recognizable things instead of a column of identical links.
- Transcripts have their own screen, separate from Scratch, reached from the hamburger menu. It keeps its own shape (title, channel, length, date) rather than dissolving into the scratch pile. The transcript-ready notification opens it at the one that just finished. Channel isn't captured today — title, duration and date are — so it has to be added at transcription time, and it becomes something I can filter and search by. Transcripts also carry optional tags, so one tagged with a project's name shows up in that project.

### Events

The calendar. Events are the clearest case of a type with a native shape that isn't a list. Today most events are created by Collaborator on my behalf, and I still keep Google Calendar because entering things there is easier. The bar for this destination is therefore not "works" but "I reach for it instead of Google."

What Google gets right is that the calendar is the form. You tap a slot on the week, drag to size the window, type a name, save. The date and duration are never typed. Today's Events view is an agenda and a month grid, both read-only: tapping opens the note, and the only way to make an event is through a chat or the notes editor. The gesture doesn't exist yet, and that is the whole gap.

Rules for the pass:

- Events opens on a **week time-grid**. Tap-and-drag on it creates an event note in place; the title is the only typed field. Start and end land in frontmatter as real fields. Agenda and month remain as the other views.
- I can enter events myself this way, and Collaborator can enter them for me from a chat, as it does now. Same note either way.
- Collaborator does not sync with Google or link an account. It swallows an **ICS** when one arrives: an ICS shared into Scratch or a chat becomes a proposed event I accept, the same way chat-drafted notes are proposed. Export to ICS already exists and stays.
- **Recurrence** is a rule in the event's frontmatter, not a second object. Occurrences are always derived, never stored: the expander takes the rule and today's date and does arithmetic, with no model involved. This is what lets the warm feed find "next Monday's" instance mechanically.
- Per-occurrence changes (one cancelled Monday, one moved to 8) are an **exceptions list** in the same frontmatter. Still one file. Exceptions before today are pruned whenever the note is next written, so the list only ever holds the future.
- Editing a note that has a rule asks "this one or all of them", the way Google does; editing a one-off never asks. "This one" writes an exception; "all of them" rewrites the rule.
- Expansion lives in the existing `list_events` path, which both the calendar views and the model's `list_events` tool already use. The model sees the same expanded occurrences I do. It can still open the note and read the rule in `fields`, which is the truth, but it never has to compute a calendar itself.

What beats Google is not the gesture, which only reaches parity. It's that an event is a note: it can carry a body, link to people and a project, and it lives in markdown I can take anywhere.

### Projects

A project is a dashboard: a window into something in motion. Not every project is software. A project is whatever a name tag gathers, and every one gets the same base view: its notes, chats, docs, events and people, with shelves for each. That is the whole of a project like the economics game or a piece of writing, and it has to stand on its own.

When the project's name matches a pi-session-manager project, an agent-team layer appears on top of the base view. It is mobile-first, so it is one scrolling page split into lanes rather than side-by-side columns:

- **Top:** the PM channel, pinned as a live strip.
- **Lead content:** intentions in flight — what I have pushed and where each one stands.
- **Shelves:** horizontally scrollable lanes for notes, chats, and docs, each with a count.
- **Branches / activity log:** its own area, keyed to the project, with a preview so I can see motion without it demanding anything.
- **Ambient health:** is it working (build, tests) and what did it cost (time, tokens, how long branches have been open), glanceable rather than leading.
- **Sandbox preview:** the running testing branch of this project's repo, launched from here so I can try the work.

Everything tagged with the project name belongs here. The exact lane layout is still undecided.

#### How a project forms

A project exists once a note is tagged `project` plus one other tag, taken as its name. Anything wearing that name joins it, chats included. A chat can wear the whole stack (project, name and a kind), since a chat can be strictly about one feature.

- `project` marks a note or chat as belonging to a project.
- The name tag says which project. The rule is single membership: a note belongs to exactly one project. So among the tags on project notes, the name is the one that never appears beside another name, while `bug` turns up beside many different names. The exclusivity check in the code is just how that rule is detected, not a way of discovering projects; the `project` tag already declares that. If an unrelated tag happens to behave like a name, the fix is an override in the app (pin this tag as a name, or ignore it), never retagging the notes, and the overrides sit in a small visible list in settings so they're not hidden state.
- Kind tags like `bug` and `feature` decide where inside the project view a note or chat shows. A bug tagged with another project's name never appears in this project's view.
- The manual state field goes, here and everywhere else it appears. It was set by hand, so it went unused, and it stopped making sense once a project became a collection of notes: a comment, an idea, a feature and a spec share no universal status. Where a status survives, it is derived from something happening to the note and belongs to that happening, not to the note. The software case is one example: a pushed note has a lifecycle (pushed, building, ready for review, merged) that lives with the PM's queue. Other kinds of project will have their own, or none.
- There is no repo field on a project note, and no repository in note frontmatter. In the case of a software project, pi-session-manager already knows which repo belongs to a project name, so storing it here would duplicate a fact that lives elsewhere, and duplicated facts drift. Collaborator does know what a repo is — it needs one to file an issue or read code when I ask it to — but it derives that from the project view, which got it from pi-session-manager, not from anything carried on a note.

#### When a project has an agent team

Everything below this point (the PM channel and team, the branch timeline, the reading view, the sandbox, and the push control on notes) is the agent-team layer. It appears only when the project's name exactly matches a pi-session-manager project tag. No project type is set by hand; the match is the switch.

#### PM channel and the team

Chats are me thinking with Collaborator (extended cognition); the PM channel is me delegating. They should look different: the PM thread reads as a channel, not a chat.

- The PM channel is a pinned fixture in each project and moves over from Telegram once this UX is settled.
- Its most recent or unread entries surface in the warm feed.
- It has two jobs: taking intent and delivering outcomes (usually involves back and forth to build), and explaining the system back to me so I can learn where the seams are and it becomes less opaque. Free-flowing conversation with the PM is essential.
- Talking to the PM is also the undo: once a note is pushed it is queued, and I amend it by talking to the PM.
- There are two ways into the PM's queue, deliberately. In the channel I can ask live questions and direct to some extent. Pushing a note is the bigger leap: it takes deliberation in chat before it's ready.
- pi-session-manager stays a separate app with its own external inference provider, which could also be local, and uses the same tag convention, so one name scopes notes, chats and agent work.&#32;

**The team.** A control at the edge of the PM channel lets me talk directly to an individual engineer.

- Only the PM acts on conversations from Collaborator.
- Other roles are configured and prompted to answer questions only, never change anything.
- The UI enforces the same thing: the engineer view is a read-only Q&A window with no way to send instructions.

#### Branch timeline and activity log

The project log is a branch timeline, not a chat transcript. All agent activity, including handoff chatter, is visible here, scoped to the project.

- The integration branch is the spine; each agent's branch spurs off it.
- Events hang off the branch they happened on, so agent chatter reads as what was said while working on that branch.
- On mobile: a vertical spine scrolling down, with agent branches as indented lanes.
- The timeline is for watching. It can show that a branch is ready and link to the PM's review, but merging happens there, not here.
- The log does not emit into the warm feed.

#### Reading agents against their reference

The branch timeline is for glancing. This is a different mode: actually reading what the agents are doing against the documents they are supposed to be following, such as the intent, the spec derived from it, and maybe the CLAUDE.md.

It is a phone view, and phone screens are vertical, so the two panes stack instead of sitting side by side.

- **Top pane: live motion.** Either the general telemetry feed across the team, or one agent's feed.
- **Bottom pane: the reference.** Any document I select.
- Narrowing the top pane to one agent auto-loads the document that agent's work was derived from, meaning the intent or spec it is building against. The pairing is already known from the push. I can override it and read something else.
- Each pane scrolls on its own, and a draggable divider between them gives either one more room. Reading a spec wants space; watching telemetry doesn't always.
- The reference pane does not try to mark where in the document the current work lands. Knowing which paragraph an agent is on would mean the agent reporting it or something guessing from the diff, and either is inference presented as fact. The right document loads on its own; finding the paragraph is mine.
- **Restart control.** In monitoring mode there are two controls for acting on the team's machinery rather than on the work: restart the agents, and pull the latest and restart. They are separate because they are different intents, shaking something loose versus taking an update. Both are overrides I reach for when things aren't behaving or there's an update to pull, not routine actions, so both sit behind the same hold-to-confirm as hold-send. There is no readout of what's mid-task before firing: by the time I press this, that's not what I'm weighing.

&#32;this is specifically meant as an override that I can employ when things aren't behaving correctly, or there's an update to pull.

#### Sandbox: trying the work

The slow part of building isn't the model writing code; it's finding out whether a change was actually good. So one button in a project's view launches that project's testing branch and shows it to me: a WebView if the work has a UI, a terminal view if it doesn't. For most software projects that is the whole feature. The testing build runs on its own, against whatever fixtures or state it normally uses, and I try it.

**Collaborator is the special case.** It is the one project, today, whose testing build has to run against my real, current state, because testing it on an empty account doesn't show what a change feels like in daily use, and real data is too precious to risk. So for Collaborator, and only Collaborator, the sandbox adds an overlay: reads check a session-scoped overlay first and fall through to real data; every write lands in the overlay; backing out discards it and I'm back where I was, untouched. Other projects may need this later, but none do now, and the overlay is not part of the general sandbox. Collaborator's preview is otherwise ordinary: the Collaborator UI, launched from the Collaborator project like any other, with no separate button in settings.

- The sandbox preview is a project-view element, next to the PM channel and the shelves.
- It sits at gate 2: from the review I can try the change before merging. Merging then means "I used it and it's good," not "the diff looks right."
- Papercuts I notice in the sandbox go to the PM in the channel.
- *Collaborator only.* PM messages and agent runs live in pi-session-manager, outside Collaborator's data store, so they survive the overlay without special handling. The side-effect risk shrinks to what the testing build itself does.
- **Where it runs.** On the dev box, beside the agents, not on the phone. A sandbox session is a git pull of the testing branch plus whatever that repo needs to run, so the dependencies stay where they already are. Any of a dozen repos can be previewed this way without installing a single runtime on the phone.
- **Collaborator runs where its data is** *(Collaborator only)*. The agents' side never sees my vault: chats, Scratch, notes, and everything else in Collaborator's database or store stay off the agent VMs, always. So Collaborator's testing build is the one that does not run on the dev box. It runs wherever the real Collaborator backend runs, next to the real data, with the overlay as a data-layer concern on that side; pi-session-manager hands over the branch and that box pulls and starts it. Today that is the web server, which should change for security reasons, but the rule doesn't depend on which box: code goes to the data, data never goes to the agents.
- **How the phone reaches it.** The manager assigns a free port per session and hands the URL back to the app; the preview pane is a WebView pointed at the dev box over the tailnet. The phone stays on Tailscale permanently, so nothing needs to be exposed publicly and no fixed port is reserved.
- **Leaving ends it.** Backing out of the preview shuts the process down; for Collaborator it also drops the overlay. Nothing is left running to find later.
- **Whose feature it is.** The sandbox belongs to pi-session-manager, not to Collaborator. pi-session-manager already owns repos, branches and agent machines, so it does the pull into a working directory on its own box, starts the process and reports back. Collaborator asks for a preview of a project and receives something to display. It never pulls or runs a repo itself.
- **Not every repo is a web app.** A WebView only helps where there's a UI. For a library or a CLI the equivalent preview is a terminal view: the process output, a test run, a log stream. Worth building, since this won't only be web development.
- **Always obvious.** A clear indicator shows I'm in a sandbox for the whole session, so I never mistake it for the real thing.
- **A test drive, not a migration path** *(Collaborator only)*. The overlay lives for one session: no save, no diff, no cherry-picking changes back into real data. Skipping the merge problem is what keeps this simple.
- **Built for small changes** *(Collaborator only)*. UX tweaks, layout moves and single features. Large schema or data-model changes are out of scope for the overlay.
- **I'm the test harness.** It works for changes I'd notice immediately while using the thing. It doesn't replace automated tests.

#### The delegation flow: chat to merge

A loose thought becomes project work without me filing anything, but two gates stay mine: pushing a note to the PM, and merging.

![Chat to merge: two gates held by me](delegation-flow.svg)

The highlighted steps are my gates. Between them sits trying it: from the review I test the work in the sandbox, and it either goes on to merge or back to the team through the PM.

**Chat to intention.** I open a new chat, and the conversation drifts into an existing project (say, the Minecraft player agent). Collaborator can notice the drift and say so in the conversation, but it doesn't reach for the tags at that point. Tags on the chat get proposed when its summary is generated from the card, or I set them myself. The substance becomes a note tagged `project` plus the project name, so it appears in that project.

**Pushing.** A note is mine until I push it to the PM.

- A note has a push control only when its project name matches a pi-session-manager project tag exactly. Notes in other projects, and notes outside any project, have none: there's no one to push to.
- Pushing sends the note as-is into the PM's queue. To amend it, I talk to the PM.

**Review and merge.** A PM card saying work is complete opens the project, not a standalone diff. The review is open there with full context.

- From the review I can try it in the sandbox, ask the PM questions, or merge. Trying comes before merging.
- Merging never happens from the feed or from a notification. The card takes me into the project's own view, and the merge control lives there, in the review, with the PM channel, branch timeline and sandbox on the same screen.
- After merging, I mostly want to go see what was built.

**Trying it.** The review is where I decide, and trying is how I find out. One control in the review launches the branch in the sandbox. pi-session-manager pulls it into a working directory on the dev box and starts it, and the preview opens inside the project view: a WebView if the work has a UI, a terminal view if it doesn't. An indicator stays up the whole time so I never mistake it for the real thing. If the project is Collaborator, it runs against my real data through the throwaway overlay.

- I use it the way I normally would. That is the test: I'm the harness, and it's for changes I'd notice in use, not a replacement for automated tests.
- Backing out shuts the process down (and, for Collaborator, drops the overlay) and returns me to the review, where the same choices are still open.
- If it's right, I merge. If it isn't, I tell the PM what's wrong in the channel; the work goes back to the team, and the next completion brings me back to this review.
- Anything I say to the PM while trying survives backing out, because the PM channel lives in pi-session-manager, not in the overlay.

## Search

Search is fragmented today: there's no search in Chats, Scratch has its own bar, Mind has another for the note graph, and web search sits behind the hamburger menu. Four bars meaning four different things.

- One search over my own world. It reaches chats, notes, Scratch, transcripts and the PM channel at once, because I usually don't know which pile something landed in.
- This search is mine, not the model's. Scratch stays unreachable to the conversation agent, as it is today: it lives in its own table, nothing logs its content, and the model sees an item only when I hold-send it. Unified search includes Scratch for me and never feeds it into the model's search tools. Whoever builds the index has to keep that line.
- A search bar inside a screen isn't a separate feature. It's the same search, scoped to what I'm looking at. these search bars should appear anywhere a user would intuitively expect.
- Web search is a different job and stays as it is for now. The LLM in chats already searches the web by tool call, and for an ordinary web search outside it I'd just open Brave, so a Brave-backed bar isn't worth rebuilding.
- The model's own search tools sort into two. Web search against the Brave API is the working one and stays. The lethe\_search tool goes: Lethe was a prototype indexer, and it's replaced by a DITTA search tool that queries my broker and gets whatever it federates to.
- What's worth having later is searching through DITTA myself, without the LLM in between. It comes in as a clearly labelled DITTA search once there are indexers and brokers worth querying; having it close at hand will help bootstrap the protocol.

## Voice

Voice is how I use Collaborator most, and it's already good. Two changes.

- Attachments mid-conversation. I should be able to hand over a photo, a link or some text without dropping out of voice. Right now needing to show it something means leaving the conversation, and that's the real gap.
- Reasoning that's actually readable. It shows while thinking and stays through the response and the speech, but it isn't genuinely expandable: the expansion is a few lines at a time. It should be full height and scroll as it streams, because the wait while it thinks is exactly when I have attention to spare and it isn't talking yet. It doesn't need to persist once the mic reopens; scrolling back is enough.

## Attachments

Attaching things mid-conversation is the one item here that isn't really a UX decision. The storage layer already exists: Scratch accepts images, audio, video and files, stores them content-addressed on disk, and serves them back through its media endpoint, and the chat composer has an attach button sitting there marked coming soon. What doesn't exist is the rest: getting a file into a chat or a call rather than only into Scratch, extracting anything from it, and indexing what comes out. The interface is the small part; that pipeline has to be built first. It deserves to be sequenced as its own piece of work, but it belongs to this overhaul.

- Ingest should be as inclusive as possible rather than a fixed list. Images, PDFs, DocX and Markdown are the obvious examples, but the world is full of file types, and if there's an existing library that handles the long tail it's worth pulling in rather than enumerating formats by hand.
- Extraction is per kind: text out of documents, OCR off scans and screenshots, and image recognition for photos. The local model already handles vision natively, OCR included, so none of this needs a second model standing beside it or a separate OCR engine wired in.
- Whatever comes out has to be stored with the attachment and indexed, so attachments fall inside the one search over my own world rather than being a blind spot in it.
- The voice feature waits on this. Handing over a photo or a link without leaving the conversation is the payoff, but it can't be built until the pipeline underneath exists.

## Notifications

- Anything that makes an agent stop working notifies me. There are two kinds. Stopped because it needs me (a question, work ready to review) arrives as the heavy card with an action. Stopped because something broke or the machine went away is a failure, and that is also the rule for when ambient health escalates into the feed.
- Stops I caused don't notify. If I flip the switch in Collaborator that stops LM Studio or the MacBook script listening for the agents, the team just shows as paused in ambient health. The suppression happens in Collaborator, because it's the thing that knows I flipped the switch; the agents will hit an error either way.
- A YouTube transcript being ready notifies me.
- None of this exists yet, at either end. There is no notification system in the app today and no delivery behind it, so this section is built from nothing rather than adjusted: the backend work is as much a part of it as the screens.
- Notifications live in the settings menu as a list, so I can add new kinds later and make them optional.
- Every item on the list is optional, with no special cases. Agent stops and YouTube transcripts are on by default.

## Object shapes and visual weight

The feed is a simple list of differently shaped objects; shape, not labels, tells me what each thing is. The more an item wants from me, the more visual weight it gets, so warmth sets the order and shape sets the urgency.

| Object | Shape | Weight |
| --- | --- | --- |
| Recent chat | Single line of text | Light |
| Note | Compact line or snippet | Light |
| PM channel entry | Card from an actor | Medium |
| Agent question / pending approval | Card with an action on it | Heavy — it is blocking on me |
| Project | Denser block with several things inside | Medium |

Tapping any object takes me into that world. Exact visuals are still open.

**Shape is a hard constraint; arrangement is not.** An object draws the same way wherever it appears, so I never learn two visual languages for the same thing. That one goes in the spec and is something I'd send work back over. How things are arranged is local and left to whoever builds the screen: the feed orders by warmth, search orders by relevance, and whether results group by kind is a judgement call in context.

**Empty states are a rule, not a design.** Every screen with nothing in it says what belongs there and how to put the first thing in, rather than just being blank. I will almost never see these, but I do plan to open source this eventually, and for a first-run user the empty state is the onboarding. The wording isn't mine to write; I'd rather meet it in the sandbox than specify it.

## Core flows

These are the everyday flows: what using Collaborator is like most of the time, in projects or out of them. Each one says what it promises, walks through how it goes, and names the decisions it rests on. Where a flow runs into something unsettled, it points at the open question rather than answering it. The software delegation flow lives under Projects, since it only exists where a project has an agent team.

### Hand-off between devices

**The promise:** something I find on one device is waiting on the other, without my filing it anywhere.

I'm on my phone and come across a link I want to look at properly later, at the Mac. I tap Scratch, the centre of the bottom bar, and drop it in. It lands at the top of the list and renders as what it is: the page's title and favicon, fetched when it arrives, not a bare URL. Photos arrive as the photo, documents as a filename and type, text as text.

Later, at the Mac, I open Scratch and it's there, drawn the same way. I open the page, or bring it into a chat and ask about it. Most transmissions simply sink down the list by recency; nothing needs clearing. If it's something I'll keep coming back to, I pin it and it stays on top. I never sort anything into categories: if the list gets long, I filter by what the items already are (links, photos, documents, text, voice), and the filter stays quiet until I reach for it.

- Rests on: Scratch is a destination and a transport, not a capture tool. There are no manual categories, and pinning is the only way to keep something up.
- Still open: how the Scratch screen is laid out and what it looks like at rest; whether arrivals from another device belong in the feed.

### Watch later, find later

**The promise:** a long video becomes something I can ask about, without watching it or waiting for it.

I drop a YouTube link into Scratch and long-press send. Unlike a plain link, this starts something: it shows as an event in flight, with the video's title, thumbnail and current state. Over the next five to ten minutes it moves from sent to transcribing to transcribed. I'm not watching; I've gone back to whatever I was doing.

When it reaches transcribed, a notification fires, and the item leaves Scratch by itself: completed events clear themselves, so Scratch only ever shows what's still in motion or still worth keeping. The transcript now lives in Transcripts, behind the hamburger menu, drawn with its own shape: title, channel, length and date.

Often I never open it. Days later, in any chat, I ask what that talk said about something, and the model finds it by content or title. The URL is an implementation detail I never say out loud. This doesn't work today: the model can only reach a transcript by re-running transcription on the same URL, so asking for the one about the trade deal fumbles unless I hand it the link. I hit this constantly, so it's real work, not a nice-to-have. Transcripts is there for the times I want to browse or read one in full.

- Rests on: Scratch items come in two species, events with a lifecycle and transmissions without one. Scratch is activity and Transcripts is retrieval. There is one search over my own world, and transcripts are found in it by content or title, never addressed by URL.
- Still open: whether finished transcripts show in the feed. A transcript belongs to a project the way anything does, by wearing its tag.

### Thinking out loud

**The promise:** talking instead of typing costs me nothing I could do with my hands.

I'm in a voice conversation, working something through while walking or driving. Partway in, I want the model to see something: a screenshot, a photo of a label, a PDF, a link. I hand it over without leaving voice. The conversation carries on, and the model responds to what I gave it, including any text in it, since the local model reads images natively.

While it thinks, its reasoning is shown at full height and scrolls as it streams, so I can actually read it rather than catching a few lines at a time. It stays up through the response and the spoken reply, and clears when the mic reopens. When the call ends, the conversation is an ordinary chat in Chats, with the attachment in it, and it can be tagged like any other.

- Rests on: voice changes only in these two ways. Attachments are their own piece of work, and voice waits on them. What's extracted from an attachment is stored and indexed, so it's never a search blind spot.

### A thought becomes a note

**The promise:** the part of a chat worth keeping ends up where it belongs, without my leaving the chat to file it.

A chat turns up something that should outlive it: a date, something about a person, a decision and why I made it. Collaborator notices and drafts it as a note on its own; this already happens today. I'm the gate: a proposed note isn't kept until I accept it. Today proposals land in an inbox; they should surface in the Feed instead, alongside everything else waiting on me. Its tags decide the rest. Tagged as an event, it becomes one, with an event's fields and its own page, and it shows up in Events. Tagged with a project's name, it joins that project. Tagged with neither, it's still a note, reachable by search.

Collaborator already proposes tags, and should somehow be made aware of what tags alreqady exist and what type the yare so it can assign accurately, and I accept or change them. As I tag, existing tags are suggested, and a new tag that's a near-miss of an existing one asks whether I meant that one, so projects don't quietly split in two. The chat itself can wear tags too; one that doesn't visibly lacks them, so it reads as loose rather than lost.

- Rests on: tags are the one organising mechanism, and a note's type comes from its tags. Tag hygiene is prevention, not repair.

### Coming back

**The promise:** after time away, one screen shows me what's warm, and anything else is one tap away.

I open the app after a day or two and land on the Feed. It mixes whatever is warm: recent chats, notes I touched, unread PM entries, anything waiting for my approval, and upcoming events, with pinned items first. Agent handoff chatter never appears here. Each item keeps its shape, so a chat reads light, a PM entry medium and an agent's question heavy; I can tell what needs me before reading a word.

Tapping an item opens it or takes me to its destination. For anything the feed doesn't show, the bottom bar is one tap away, and search reaches all of my own world: chats, notes, Scratch, transcripts and the PM channel.

- Rests on: the warm feed is home, pinning is needed, and shape carries meaning while arrangement doesn't.
- Still open: exactly what belongs in the feed.

## Open questions

- [ ] How exactly are the project lanes laid out on mobile?
- [x] Does anything get pinned in the warm feed, or is it purely ordered by warmth?
- [ ] What does each object shape actually look like?
- [x] Where does merge land me? Answered: merging happens inside the project view, after trying it in the sandbox, and afterwards I go see what was built.
- [x] Tag proposals: Collaborator proposes tags every time it drafts a note, as it already does. For chats, tags are proposed only when a chat's summary is generated from the three-dots card; otherwise chat tagging is manual. Collaborator may still remark in conversation that a chat is drifting into a project; it just doesn't apply or propose tags mechanically at that moment.
- [x] Transcripts carry optional tags, like everything else. A transcript tagged with a project's name belongs to that project on that basis alone; there is no separate notion of a transcript being a project object.
- [x] There are now two ways into the PM's queue: pushed notes, and papercuts told to the PM in the channel. Is that deliberate, and does the PM treat them differently?
- [x] Reference pane marking the current paragraph: dropped. The pane auto-loads the right document and I scroll.
- [x] The flow diagram doesn't show the try-it step at gate 2 yet.
- [x] Restart control: two controls (restart, pull-and-restart), both hold-to-confirm, no in-flight readout.
- [x] Untagged chats and notes: not homeless. Chats and Notes are exhaustive lists, so nothing is reachable only by remembering it; Feed shows what's warm and search finds the rest. Chats and Notes get a derived "no tag" filter, like Scratch's, so loose things can be rounded up.
- [x] Bottom bar, or another way to keep the destinations always one tap away?
- [x] Floating button or a composer strip above the bar for Scratch?
- [x] Per-type note pages, settled for the two types that have them. **Event:** date first, then the recurrence rule and any exceptions where they exist, then the body, with its links to people and a project. **Person:** their fields and the note's own body lead; what references them (notes, chats, events) sits underneath as links. The People list itself is alphabetical with letter separators (A, B, C…), nothing more for now. Goal, question and decision pages are off the table; those are plain tags.
- [x] Scratch layout: it looks like a chat, and it already nearly does. The one change is direction: today newest is at the top, and it should be newest at the bottom, the way a chat reads, with the composer under it. Transient events just disappear when they complete. Derived filters remain. Where pinned items sit in a chat-shaped list is left to implementation.
- [x] What do mixed-type search results look like? Shape is fixed globally; grouping and ordering are the implementer's call.
- [ ] Recall of chat turns from a note. Notes come from turns, but the model can't get back to the turns a note came from. Parked; not tangled with Events.
- [ ] Collaborator sandbox side effects beyond the data store: if the testing build itself sends a message, pushes to git or calls an external service, the overlay can't undo it. Block, stub, or accept?
- [ ] Collaborator sandbox schema drift: what happens when the testing branch expects a data format the stable version doesn't have yet?
- [ ] What belongs in the warm feed? Current list (recent chats, touched notes, upcoming events, PM entries, pending approvals) is provisional. Undecided: Scratch arrivals, finished transcripts, and merged work.
- [x] How does a note get made from a chat: do I ask for it, is there a control, or does Collaborator offer?
- [ ] Seeds vs conversations: the distinction survives and Conversations hides inside the Chats area, but what promotion is for, and how the hidden list is reached, is undecided. Top-bar control beside the hamburger is the current guess.
