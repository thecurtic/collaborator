import { CalendarDays, MapPin, Repeat, Users } from 'lucide-react';
import { fromRepeatRule, toRepeatRule } from '@/domain/adapters';
import type { NoteFields, NoteFieldsPatch, RepeatFreq } from '@/domain/models';
import { describeRepeat } from '@/features/calendar/calendarDates';
import { PROFILE_AREAS } from './categories';
import {
  formatEventRange,
  toDateInput,
  toDateTimeLocalInput,
} from './eventFields';

/**
 * Shared per-type frontmatter editing (1f18a9b), used by the note editor
 * and the drafts inbox. Working state is a flat string map (FieldsDraft):
 * booleans as ''/'1', lists comma-joined — trivial to diff and to bind to
 * inputs. draftToPatch converts back to the wire shape, emitting only
 * changed keys ('' / [] clears server-side).
 */
export type FieldsDraft = Record<string, string>;

const INPUT_CLS =
  'mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const LABEL_CLS = 'text-xs text-muted-foreground';

/** Keys the editor manages for a type (hub adds the USER-only facts). */
function keysFor(category: string | null, isUserHub: boolean): string[] {
  const base =
    category === 'event'
      ? ['all_day', 'start', 'end', 'repeat', 'location', 'people']
      : category === 'social-graph'
        ? ['kind', 'relation', 'birthday', 'aliases']
        : category === 'user-profile'
          ? ['area']
          : [];
  return isUserHub
    ? [...base, 'name', 'dob', 'resides_in', 'timezone']
    : base;
}

/** Build the editor's working state from a note/draft's current fields. */
export function fieldsToDraft(
  category: string | null,
  fields: NoteFields | null,
  isUserHub = false,
): FieldsDraft {
  const f = fields;
  const all: FieldsDraft = {
    all_day: f?.allDay ? '1' : '',
    start: f?.start
      ? f.allDay
        ? toDateInput(f.start)
        : toDateTimeLocalInput(f.start)
      : '',
    end: f?.end
      ? f.allDay
        ? toDateInput(f.end)
        : toDateTimeLocalInput(f.end)
      : '',
    location: f?.location ?? '',
    people: (f?.people ?? []).join(', '),
    // The rule travels as JSON in the flat draft ('' = doesn't repeat).
    repeat: f?.repeat ? JSON.stringify(fromRepeatRule(f.repeat)) : '',
    kind: f?.kind ?? '',
    relation: f?.relation ?? '',
    birthday: f?.birthday ?? '',
    aliases: (f?.aliases ?? []).join(', '),
    area: f?.area ?? '',
    name: f?.name ?? '',
    dob: f?.dob ?? '',
    resides_in: f?.residesIn ?? '',
    timezone: f?.timezone ?? '',
  };
  const out: FieldsDraft = {};
  for (const k of keysFor(category, isUserHub)) out[k] = all[k];
  return out;
}

const splitList = (v: string) =>
  v
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Only the CHANGED keys, in wire shape; undefined when nothing changed.
 * '' (and []) pass through — that's the clear-a-key contract.
 */
export function draftToPatch(
  current: FieldsDraft,
  original: FieldsDraft,
): NoteFieldsPatch | undefined {
  const patch: NoteFieldsPatch = {};
  for (const key of Object.keys(current)) {
    if (current[key] === original[key]) continue;
    if (key === 'all_day') patch[key] = current[key] === '1';
    else if (key === 'people' || key === 'aliases') {
      patch[key] = splitList(current[key]);
    } else if (key === 'repeat') {
      patch[key] = current[key] ? (JSON.parse(current[key]) as object) : '';
    } else patch[key] = current[key];
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

const EMPTY_FIELDS: NoteFields = {
  start: null,
  end: null,
  allDay: false,
  location: null,
  people: [],
  repeat: null,
  exceptions: [],
  aliases: [],
  kind: null,
  relation: null,
  birthday: null,
  area: null,
  name: null,
  dob: null,
  residesIn: null,
  timezone: null,
};

/**
 * Live NoteFields view of an in-progress edit (base + the draft's keys) —
 * lets read-mode summaries reflect unsaved changes.
 */
export function draftToFields(
  base: NoteFields | null,
  d: FieldsDraft,
): NoteFields {
  const f: NoteFields = { ...EMPTY_FIELDS, ...(base ?? {}) };
  if ('start' in d) f.start = d.start || null;
  if ('end' in d) f.end = d.end || null;
  if ('all_day' in d) f.allDay = d.all_day === '1';
  if ('location' in d) f.location = d.location || null;
  if ('people' in d) f.people = splitList(d.people);
  if ('repeat' in d) f.repeat = d.repeat ? toRepeatRule(JSON.parse(d.repeat)) : null;
  if ('kind' in d) f.kind = d.kind || null;
  if ('relation' in d) f.relation = d.relation || null;
  if ('birthday' in d) f.birthday = d.birthday || null;
  if ('aliases' in d) f.aliases = splitList(d.aliases);
  if ('area' in d) f.area = d.area || null;
  if ('name' in d) f.name = d.name || null;
  if ('dob' in d) f.dob = d.dob || null;
  if ('resides_in' in d) f.residesIn = d.resides_in || null;
  if ('timezone' in d) f.timezone = d.timezone || null;
  return f;
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className={LABEL_CLS}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className={INPUT_CLS}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  allowEmpty,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  allowEmpty?: string;
}) {
  return (
    <label className="block">
      <span className={LABEL_CLS}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className={INPUT_CLS}
      >
        {allowEmpty != null && <option value="">{allowEmpty}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/**
 * An event's repeat rule (NOTES-FORMAT.md, Recurrence) as plain controls:
 * how often, every N, which weekdays, and when it ends. Editing the rule
 * here changes ALL occurrences; one date is changed from the calendar.
 */
function RepeatEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const rule = value ? (JSON.parse(value) as Record<string, unknown>) : null;
  const write = (next: Record<string, unknown> | null) =>
    onChange(next ? JSON.stringify(next) : '');
  const freq = (rule?.freq as RepeatFreq | undefined) ?? '';
  const days = (rule?.by_day as string[] | undefined) ?? [];
  const ends = rule?.until ? 'until' : rule?.count ? 'count' : 'never';
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Repeats"
          value={freq}
          options={['daily', 'weekly', 'monthly', 'yearly']}
          onChange={(v) => write(v ? { ...(rule ?? {}), freq: v, ...(v !== 'weekly' ? { by_day: undefined } : {}) } : null)}
          allowEmpty="(doesn't repeat)"
        />
        {freq && (
          <TextField
            label={`Every N ${({ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' } as const)[freq]}`}
            type="number"
            value={String(rule?.interval ?? 1)}
            onChange={(v) => write({ ...rule, interval: Math.max(1, Number(v) || 1) })}
          />
        )}
      </div>
      {freq === 'weekly' && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Weekdays">
          {DAY_CODES.map((c, i) => {
            const on = days.includes(c);
            return (
              <button key={c} type="button" aria-pressed={on}
                      onClick={() => write({ ...rule, by_day: on ? days.filter((d) => d !== c) : [...days, c] })}
                      className={'h-7 w-9 rounded-md border text-[11px] ' +
                        (on ? 'border-primary bg-primary/10 text-primary' : 'border-input text-muted-foreground')}>
                {new Date(2026, 0, 5 + i).toLocaleDateString([], { weekday: 'short' })}
              </button>
            );
          })}
        </div>
      )}
      {freq && (
        <div className="grid grid-cols-2 gap-2">
          <SelectField
            label="Ends"
            value={ends}
            options={['never', 'until', 'count']}
            onChange={(v) => {
              const { until: _u, count: _c, ...rest } = rule ?? {};
              write(v === 'until' ? { ...rest, until: new Date().toISOString().slice(0, 10) }
                : v === 'count' ? { ...rest, count: 10 } : rest);
            }}
          />
          {ends === 'until' && (
            <TextField label="On" type="date" value={String(rule?.until ?? '')}
                       onChange={(v) => write({ ...rule, until: v })} />
          )}
          {ends === 'count' && (
            <TextField label="After N times" type="number" value={String(rule?.count ?? '')}
                       onChange={(v) => write({ ...rule, count: Math.max(1, Number(v) || 1) })} />
          )}
        </div>
      )}
    </div>
  );
}

/** The typed inputs for one type's fields (nothing for untyped notes). */
export function FieldsEditor({
  category,
  draft,
  onChange,
  isUserHub = false,
}: {
  category: string | null;
  draft: FieldsDraft;
  onChange: (next: FieldsDraft) => void;
  isUserHub?: boolean;
}) {
  if (Object.keys(draft).length === 0) return null;
  const set = (key: string) => (v: string) => onChange({ ...draft, [key]: v });
  const allDay = draft.all_day === '1';

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2">
      {category === 'event' && (
        <>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => {
                const v = e.target.checked;
                // date ↔ datetime-local: truncate, or default to noon.
                const convert = (s: string) =>
                  !s ? s : v ? s.slice(0, 10) : `${s.slice(0, 10)}T12:00`;
                onChange({
                  ...draft,
                  all_day: v ? '1' : '',
                  start: convert(draft.start),
                  end: convert(draft.end),
                });
              }}
            />
            All day
          </label>
          <div className="grid grid-cols-2 gap-2">
            <TextField
              label="Starts"
              type={allDay ? 'date' : 'datetime-local'}
              value={draft.start}
              onChange={set('start')}
            />
            <TextField
              label="Ends (optional)"
              type={allDay ? 'date' : 'datetime-local'}
              value={draft.end}
              onChange={set('end')}
            />
          </div>
          <RepeatEditor value={draft.repeat} onChange={set('repeat')} />
          <TextField
            label="Location"
            value={draft.location}
            onChange={set('location')}
          />
          <TextField
            label="People (comma-separated note titles)"
            value={draft.people}
            onChange={set('people')}
            placeholder="Sarah Chen, Robert Chen"
          />
        </>
      )}
      {category === 'social-graph' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label="Kind"
              value={draft.kind}
              options={['person', 'org']}
              onChange={set('kind')}
              allowEmpty="(person)"
            />
            <TextField
              label="Birthday"
              value={draft.birthday}
              onChange={set('birthday')}
              placeholder="YYYY-MM-DD or MM-DD"
            />
          </div>
          <TextField
            label="Relation"
            value={draft.relation}
            onChange={set('relation')}
            placeholder="sister, coworker, dentist…"
          />
          <TextField
            label="Aliases (comma-separated)"
            value={draft.aliases}
            onChange={set('aliases')}
          />
        </>
      )}
      {category === 'user-profile' && !isUserHub && (
        <SelectField
          label="Profile area"
          value={draft.area}
          options={PROFILE_AREAS}
          onChange={set('area')}
          allowEmpty="(none)"
        />
      )}
      {isUserHub && (
        <div className="grid grid-cols-2 gap-2">
          <TextField label="Name" value={draft.name} onChange={set('name')} />
          <TextField
            label="Date of birth"
            type="date"
            value={draft.dob}
            onChange={set('dob')}
          />
          <TextField
            label="Resides in"
            value={draft.resides_in}
            onChange={set('resides_in')}
          />
          <TextField
            label="Timezone"
            value={draft.timezone}
            onChange={set('timezone')}
            placeholder="America/Denver"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Read-mode fields block for note/draft views. Compact, type-aware;
 * renders nothing when there's nothing to show.
 */
export function FieldsSummary({
  category,
  fields,
  onOpenNote,
}: {
  category: string | null;
  fields: NoteFields | null;
  onOpenNote?: (title: string) => void;
}) {
  if (!fields || !category) return null;
  const rows: React.ReactNode[] = [];

  if (category === 'event' && fields.start) {
    rows.push(
      <div key="when" className="flex items-center gap-2 text-sm font-medium">
        <CalendarDays className="h-4 w-4 shrink-0 text-primary" />
        {formatEventRange(fields)}
      </div>,
    );
    if (fields.repeat) {
      const changes = fields.exceptions.length;
      rows.push(
        <div key="repeat" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Repeat className="h-3.5 w-3.5 shrink-0" />
          {describeRepeat(fields.repeat)}
          {changes > 0 && ` · ${changes} ${changes === 1 ? 'date changed' : 'dates changed'}`}
        </div>,
      );
    }
    if (fields.location) {
      rows.push(
        <div
          key="where"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          {fields.location}
        </div>,
      );
    }
    if (fields.people.length > 0) {
      rows.push(
        <div key="who" className="flex flex-wrap items-center gap-1.5">
          <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {fields.people.map((p) =>
            onOpenNote ? (
              <button
                key={p}
                type="button"
                onClick={() => onOpenNote(p)}
                className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-accent-foreground hover:bg-accent/70"
              >
                {p}
              </button>
            ) : (
              <span
                key={p}
                className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-accent-foreground"
              >
                {p}
              </span>
            ),
          )}
        </div>,
      );
    }
  }
  if (category === 'social-graph') {
    const facts = [
      fields.kind === 'org' ? 'organization' : null,
      fields.relation,
      fields.birthday ? `birthday ${fields.birthday}` : null,
      fields.aliases.length > 0 ? `aka ${fields.aliases.join(', ')}` : null,
    ].filter(Boolean);
    if (facts.length > 0) {
      rows.push(
        <div key="person" className="text-xs text-muted-foreground">
          {facts.join(' · ')}
        </div>,
      );
    }
  }
  if (category === 'user-profile' && fields.area) {
    rows.push(
      <div key="area" className="text-xs text-muted-foreground">
        profile area: {fields.area}
      </div>,
    );
  }

  if (rows.length === 0) return null;
  return (
    <div className="mb-3 space-y-1.5 rounded-md bg-primary/5 px-2.5 py-2">
      {rows}
    </div>
  );
}
