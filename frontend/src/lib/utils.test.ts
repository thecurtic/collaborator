import { describe, expect, it } from 'vitest';
import { parseApiDate } from './utils';

describe('parseApiDate', () => {
  it('treats SQLite "YYYY-MM-DD HH:MM:SS" as UTC', () => {
    const d = parseApiDate('2026-07-04 12:30:00');
    expect(d.toISOString()).toBe('2026-07-04T12:30:00.000Z');
  });

  it('passes real ISO strings through', () => {
    const d = parseApiDate('2026-07-04T12:30:00.000Z');
    expect(d.toISOString()).toBe('2026-07-04T12:30:00.000Z');
  });
});
