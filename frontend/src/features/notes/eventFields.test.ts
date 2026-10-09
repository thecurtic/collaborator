import { describe, expect, it } from 'vitest';
import {
  formatEventRange,
  toDateInput,
  toDateTimeLocalInput,
} from './eventFields';

// Fixed "now" so year elision is deterministic.
const NOW = new Date(2026, 0, 15);

describe('formatEventRange', () => {
  it('renders a timed same-day range without the current year', () => {
    const s = formatEventRange(
      { start: '2026-08-02T14:00', end: '2026-08-02T15:00', allDay: false },
      NOW,
    );
    expect(s).toContain('Aug 2');
    expect(s).not.toContain('2026');
    expect(s).toMatch(/2:00.*3:00/);
  });

  it('renders all-day without times and parses date-only as LOCAL', () => {
    const s = formatEventRange(
      { start: '2026-08-02', end: null, allDay: true },
      NOW,
    );
    // Local parse: must be Aug 2 in every timezone, never Aug 1.
    expect(s).toContain('Aug 2');
    expect(s).toContain('all day');
  });

  it('renders cross-day timed ranges with both days', () => {
    const s = formatEventRange(
      { start: '2026-08-02T22:00', end: '2026-08-03T09:00', allDay: false },
      NOW,
    );
    expect(s).toContain('Aug 2');
    expect(s).toContain('Aug 3');
  });

  it('includes the year when not the current one', () => {
    const s = formatEventRange(
      { start: '2027-03-01T10:00', end: null, allDay: false },
      NOW,
    );
    expect(s).toContain('2027');
  });

  it('falls back to the raw string for junk (values under review stay visible)', () => {
    expect(
      formatEventRange({ start: 'next tuesday-ish', end: null, allDay: false }),
    ).toBe('next tuesday-ish');
  });
});

describe('input value helpers', () => {
  it('formats datetime-local values from wall-clock strings', () => {
    expect(toDateTimeLocalInput('2026-08-02T14:00')).toBe('2026-08-02T14:00');
    expect(toDateTimeLocalInput('2026-08-02')).toBe('2026-08-02T00:00');
  });

  it('formats date values without UTC day-shift', () => {
    expect(toDateInput('2026-08-02')).toBe('2026-08-02');
  });
});
