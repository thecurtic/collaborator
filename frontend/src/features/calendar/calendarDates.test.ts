import { describe, expect, it } from 'vitest';
import type { NoteMeta } from '@/domain/models';
import {
  allDayOn,
  describeRepeat,
  eventKey,
  isoLocal,
  placeDayEvents,
  snapMinutes,
  startOfWeek,
} from './calendarDates';

function ev(title: string, start: string, end: string | null = null,
            allDay = false, occurrence: string | null = null): NoteMeta {
  return {
    filename: `${title}.md`, title, created: null, tags: ['event'], sourceTurns: [],
    links: [], score: null, occurrence, recurring: occurrence != null, moved: false, edited: null,
    fields: {
      start, end, allDay, location: null, people: [], repeat: null, exceptions: [],
      aliases: [], kind: null, relation: null, birthday: null, area: null,
      name: null, dob: null, residesIn: null, timezone: null,
    },
  };
}

const day = new Date(2026, 9, 19); // Mon Oct 19 2026

describe('week math', () => {
  it('weeks start on Monday', () => {
    expect(startOfWeek(new Date(2026, 9, 25)).getDate()).toBe(19); // Sun -> Mon 19
    expect(startOfWeek(new Date(2026, 9, 19)).getDate()).toBe(19);
  });
  it('snaps to 15 minutes and formats local wall clock', () => {
    expect(snapMinutes(9 * 60 + 52)).toBe(9 * 60 + 45);
    expect(isoLocal(new Date(2026, 9, 19, 9, 5))).toBe('2026-10-19T09:05');
  });
  it('keys occurrences apart', () => {
    expect(eventKey(ev('A', '2026-10-19T09:00', null, false, '2026-10-19'))).not.toBe(
      eventKey(ev('A', '2026-10-26T09:00', null, false, '2026-10-26')));
  });
});

describe('placeDayEvents', () => {
  it('places, clamps, and splits overlaps into lanes', () => {
    const placed = placeDayEvents([
      ev('A', '2026-10-19T09:00', '2026-10-19T10:00'),
      ev('B', '2026-10-19T09:30', '2026-10-19T11:00'),
      ev('C', '2026-10-19T12:00'),                       // no end -> 1h
      ev('D', '2026-10-19T23:00', '2026-10-20T01:00'),   // cut at midnight
      ev('E', '2026-10-20T09:00'),                       // other day
      ev('F', '2026-10-19', null, true),                  // all-day: not here
    ], day);
    const by = Object.fromEntries(placed.map((p) => [p.event.title, p]));
    expect(Object.keys(by).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect([by.A.lane, by.B.lane, by.A.lanes]).toEqual([0, 1, 2]);
    expect([by.C.top, by.C.bottom, by.C.lanes]).toEqual([720, 780, 1]);
    expect(by.D.bottom).toBe(1440);
  });
  it('gives short events a readable height', () => {
    const [p] = placeDayEvents([ev('Q', '2026-10-19T09:00', '2026-10-19T09:05')], day);
    expect(p.bottom - p.top).toBe(30);
  });
});

describe('all-day and rules', () => {
  it('spans all-day events across their days', () => {
    const h = ev('Holiday', '2026-10-18', '2026-10-20', true);
    expect(allDayOn([h], day)).toHaveLength(1);
    expect(allDayOn([h], new Date(2026, 9, 21))).toHaveLength(0);
  });
  it('describes a rule in words', () => {
    expect(describeRepeat({ freq: 'weekly', byDay: ['MO', 'TH'], count: 6 }))
      .toMatch(/^Weekly on .+, .+ · 6 times$/);
    expect(describeRepeat({ freq: 'monthly', interval: 2 })).toBe('Every 2 months');
  });
});
