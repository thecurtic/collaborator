import {
  Cake,
  Clock,
  FileText,
  Loader2,
  MapPin,
  SquarePen,
  UserCircle,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/api/collaborator';
import { ApiRequestError } from '@/api/http';
import { Button } from '@/components/ui/button';
import type { Note, NoteMeta } from '@/domain/models';
import { PROFILE_AREAS } from './categories';
import { parseWallClock } from './eventFields';
import { NoteBody } from './NoteBody';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Whole years since `dob` (a wall-clock date string), or null. */
function ageFrom(dob: string, now: Date): number | null {
  const d = parseWallClock(dob);
  if (!d) return null;
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 200 ? age : null;
}

/** "Mar 4, 1990" when parseable; the raw string otherwise (never hide it). */
function formatDob(dob: string): string {
  const d = parseWallClock(dob);
  return d
    ? d.toLocaleDateString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : dob;
}

/** Satellites grouped by fields.area in PROFILE_AREAS order; unknown last. */
function groupSatellites(
  notes: NoteMeta[],
): { area: string; notes: NoteMeta[] }[] {
  const groups = new Map<string, NoteMeta[]>();
  for (const n of notes) {
    const raw = n.fields?.area?.trim().toLowerCase() ?? '';
    const area = PROFILE_AREAS.includes(raw) ? raw : 'other';
    const list = groups.get(area);
    if (list) list.push(n);
    else groups.set(area, [n]);
  }
  return [...PROFILE_AREAS, 'other'].flatMap((area) => {
    const list = groups.get(area);
    return list
      ? [
          {
            area,
            notes: [...list].sort((a, b) => a.title.localeCompare(b.title)),
          },
        ]
      : [];
  });
}

/**
 * The user's own profile: the USER hub note (typed facts + body) plus its
 * user-profile satellite notes grouped by area. Renders in the Notes list
 * area — the host owns the header, search bar, and category chips. Editing
 * flows through the normal note screen via onOpenNote('USER').
 */
export function ProfileView({
  onOpenNote,
}: {
  onOpenNote: (title: string) => void;
}) {
  const [user, setUser] = useState<Note | null>(null);
  // getNote('USER') 404'd — no hub note scaffolded yet (not an error).
  const [userMissing, setUserMissing] = useState(false);
  const [satellites, setSatellites] = useState<NoteMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getNote('USER')
      .then((n) => {
        if (!cancelled) setUser(n);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setUserMissing(true);
        } else {
          setError(errMessage(err));
        }
      });
    api
      .listNotes('user-profile')
      .then((res) => {
        // The hub itself may carry the tag — it's rendered above, not listed.
        if (!cancelled) setSatellites(res.filter((n) => n.title !== 'USER'));
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errMessage(err));
          setSatellites([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (user === null && !userMissing && !error) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading profile…
      </div>
    );
  }

  const facts: { icon: LucideIcon; label: string; value: string }[] = [];
  const f = user?.fields;
  if (f?.name) facts.push({ icon: UserCircle, label: 'Name', value: f.name });
  if (f?.dob) {
    const age = ageFrom(f.dob, new Date());
    facts.push({
      icon: Cake,
      label: 'Born',
      value: age != null ? `${formatDob(f.dob)} (${age})` : formatDob(f.dob),
    });
  }
  if (f?.residesIn) {
    facts.push({ icon: MapPin, label: 'Lives in', value: f.residesIn });
  }
  if (f?.timezone) {
    facts.push({ icon: Clock, label: 'Timezone', value: f.timezone });
  }

  const grouped = groupSatellites(satellites ?? []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {userMissing && (
        <div className="py-8 text-center text-muted-foreground">
          <UserCircle className="mx-auto mb-3 h-8 w-8 opacity-40" />
          <p className="text-lg font-medium text-foreground">No profile yet</p>
          <p className="mt-1 px-8 text-sm">
            Run a vault reindex to scaffold USER, or let the agent learn about
            you.
          </p>
        </div>
      )}

      {user && (
        <>
          {facts.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border px-3 py-2.5 sm:grid-cols-4">
              {facts.map((fact) => (
                <div key={fact.label} className="min-w-0">
                  <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    <fact.icon className="h-3 w-3" />
                    {fact.label}
                  </p>
                  <p className="truncate text-sm text-foreground">
                    {fact.value}
                  </p>
                </div>
              ))}
            </div>
          )}
          <NoteBody body={user.body} onOpenNote={onOpenNote} />
          <div className="mt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenNote('USER')}
              className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
            >
              <SquarePen className="h-3.5 w-3.5" />
              Open USER note
            </Button>
          </div>
        </>
      )}

      {grouped.length > 0 && (
        <div className="mt-6 border-t border-border pt-3">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Profile notes
          </p>
          {grouped.map((g) => (
            <div key={g.area} className="mb-2">
              <p className="mb-0.5 text-xs capitalize text-muted-foreground">
                {g.area}
              </p>
              <ul className="divide-y divide-border">
                {g.notes.map((n) => (
                  <li key={n.filename}>
                    <button
                      type="button"
                      onClick={() => onOpenNote(n.title)}
                      className="flex w-full items-center gap-3 px-1 py-2.5 text-left hover:bg-muted/60 active:bg-muted"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-primary/70" />
                      <span className="truncate text-sm font-medium text-foreground">
                        {n.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
