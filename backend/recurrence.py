"""Recurring events (NOTES-FORMAT.md, Recurrence): one note, a rule, an
exceptions list. Occurrences are always derived, never stored — this module
takes the rule, the exceptions and a window and does arithmetic, nothing else.

repeat:     {freq: daily|weekly|monthly|yearly, interval: int (1),
             by_day: [MO..SU] (weekly), by_month_day: int (monthly),
             until: YYYY-MM-DD | count: int}
exceptions: [{date: YYYY-MM-DD (the occurrence's ORIGINAL date),
              cancelled: true | start/end (replacement) | note: <title>}]

The note's own start/end are the first occurrence: they set the time of day
and the duration. Exceptions are kept forever (a pruned cancellation would
reappear as having happened).
"""

import calendar
import datetime as _dt
from typing import Dict, Iterator, List, Optional, Tuple

FREQS = ("daily", "weekly", "monthly", "yearly")
WEEKDAYS = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
MAX_OCCURRENCES = 2000          # per series per expansion — a runaway guard
_DATE_LEN = 10


def validate_repeat(value) -> Tuple[Optional[dict], Optional[str]]:
    """(normalized rule, error). Empty dict/None means "no rule"."""
    if value in (None, "", {}):
        return None, None
    if not isinstance(value, dict):
        return None, "repeat must be an object like {freq: weekly, by_day: [MO]}"
    freq = str(value.get("freq") or "").strip().lower()
    if freq not in FREQS:
        return None, f"repeat.freq must be one of {', '.join(FREQS)}"
    out = {"freq": freq}
    try:
        raw = value.get("interval")
        interval = 1 if raw in (None, "") else int(raw)
    except (TypeError, ValueError):
        return None, "repeat.interval must be a whole number"
    if interval < 1 or interval > 365:
        return None, "repeat.interval must be between 1 and 365"
    if interval != 1:
        out["interval"] = interval
    if value.get("by_day") not in (None, "", []):
        if freq != "weekly":
            return None, "repeat.by_day applies only to weekly rules"
        days = value["by_day"] if isinstance(value["by_day"], list) else [value["by_day"]]
        days = [str(d).strip().upper()[:2] for d in days]
        bad = [d for d in days if d not in WEEKDAYS]
        if bad:
            return None, f"repeat.by_day takes MO TU WE TH FR SA SU; got {bad}"
        out["by_day"] = [d for d in WEEKDAYS if d in days]
    if value.get("by_month_day") not in (None, ""):
        if freq != "monthly":
            return None, "repeat.by_month_day applies only to monthly rules"
        try:
            md = int(value["by_month_day"])
        except (TypeError, ValueError):
            return None, "repeat.by_month_day must be a day number (1-31)"
        if not 1 <= md <= 31:
            return None, "repeat.by_month_day must be between 1 and 31"
        out["by_month_day"] = md
    until, count = value.get("until"), value.get("count")
    if until not in (None, "") and count not in (None, ""):
        return None, "repeat takes until OR count, not both"
    if until not in (None, ""):
        try:
            out["until"] = _dt.date.fromisoformat(str(until)[:_DATE_LEN]).isoformat()
        except ValueError:
            return None, "repeat.until must be an ISO date (YYYY-MM-DD)"
    if count not in (None, ""):
        try:
            c = int(count)
        except (TypeError, ValueError):
            return None, "repeat.count must be a whole number"
        if c < 1:
            return None, "repeat.count must be at least 1"
        out["count"] = c
    return out, None


def validate_exceptions(value, valid_when) -> Tuple[Optional[list], Optional[str]]:
    """(normalized list, error). `valid_when(s)` validates a start/end string
    (the caller's ISO rules). One entry per original date; the last wins."""
    if value in (None, "", []):
        return None, None
    if not isinstance(value, list):
        return None, "exceptions must be a list of {date, cancelled|start/end|note}"
    by_date: Dict[str, dict] = {}
    for raw in value:
        if not isinstance(raw, dict):
            return None, "each exception is an object with a date"
        try:
            date = _dt.date.fromisoformat(str(raw.get("date") or "")[:_DATE_LEN]).isoformat()
        except ValueError:
            return None, "exception.date must be the occurrence's original ISO date"
        entry = {"date": date}
        kinds = [k for k in ("cancelled", "note") if raw.get(k)]
        moved = any(raw.get(k) for k in ("start", "end"))
        if len(kinds) + (1 if moved else 0) != 1:
            return None, (f"exception for {date}: give exactly one of cancelled: true, "
                          "a replacement start/end, or note: <title>")
        if raw.get("cancelled"):
            entry["cancelled"] = True
        elif raw.get("note"):
            entry["note"] = " ".join(str(raw["note"]).split())[:180]
        else:
            for k in ("start", "end"):
                if raw.get(k):
                    v = str(raw[k]).strip()
                    err = valid_when(k, v)
                    if err:
                        return None, f"exception for {date}: {err}"
                    entry[k] = v
            if "start" not in entry:
                return None, f"exception for {date}: a moved occurrence needs a start"
        by_date[date] = entry
    return [by_date[d] for d in sorted(by_date)], None


# --- Expansion --------------------------------------------------------------------

def _parse_when(value: str) -> Tuple[_dt.datetime, bool]:
    """(naive wall-clock datetime, all_day). Offsets are dropped: occurrences
    keep the wall-clock time and get their own date's offset (DST-correct)."""
    s = str(value).strip()
    if len(s) == _DATE_LEN:
        return _dt.datetime.fromisoformat(s + "T00:00"), True
    dt = _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.replace(second=0, microsecond=0), False


def _fmt(dt: _dt.datetime, all_day: bool) -> str:
    if all_day:
        return dt.date().isoformat()
    off = dt.astimezone().strftime("%z")              # this date's local offset
    return f"{dt.strftime('%Y-%m-%dT%H:%M')}{off[:3]}:{off[3:]}"


def _add_months(d: _dt.date, months: int, day: int) -> Optional[_dt.date]:
    """d moved by `months`, on `day` — None when that month lacks the day
    (a rule on the 31st skips short months, as RFC 5545 does)."""
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    if day > calendar.monthrange(y, m)[1]:
        return None
    return _dt.date(y, m, day)


def occurrence_dates(first: _dt.date, rule: dict) -> Iterator[_dt.date]:
    """Every date the rule produces, from the series' first date, in order,
    honouring until/count (count includes the first occurrence)."""
    freq, interval = rule["freq"], int(rule.get("interval") or 1)
    until = _dt.date.fromisoformat(rule["until"]) if rule.get("until") else None
    count = rule.get("count")
    produced = 0

    def gen():
        if freq == "daily":
            d = first
            while True:
                yield d
                d += _dt.timedelta(days=interval)
        elif freq == "weekly":
            days = rule.get("by_day") or [WEEKDAYS[first.weekday()]]
            idx = sorted(WEEKDAYS.index(x) for x in days)
            week0 = first - _dt.timedelta(days=first.weekday())
            k = 0
            while True:
                base = week0 + _dt.timedelta(weeks=k * interval)
                for i in idx:
                    d = base + _dt.timedelta(days=i)
                    if d >= first:
                        yield d
                k += 1
        elif freq == "monthly":
            day = rule.get("by_month_day") or first.day
            k = 0
            while True:
                d = _add_months(first.replace(day=1), k * interval, day)
                if d is not None and d >= first:
                    yield d
                k += 1
                if k > 12 * 400:
                    return
        else:                                             # yearly
            k = 0
            while True:
                y = first.year + k * interval
                try:
                    yield first.replace(year=y)
                except ValueError:                        # Feb 29 in a short year
                    pass
                k += 1
                if k > 400:
                    return

    for d in gen():
        if until and d > until:
            return
        if count is not None and produced >= count:
            return
        produced += 1
        yield d


def expand(start: str, end: Optional[str], rule: dict,
           exceptions: Optional[List[dict]], window_start: Optional[str],
           window_end: Optional[str]) -> List[Dict]:
    """Occurrences overlapping the inclusive window, each {date (original),
    start, end, moved, exception_note}. Cancelled ones and ones replaced by a
    one-off note are left out (the one-off is an ordinary event note and
    lists itself). Without a window, nothing is expanded (an infinite series
    has no list) — callers export the rule instead."""
    if not window_start or not window_end:
        return []
    s0, all_day = _parse_when(start)
    duration = (_parse_when(end)[0] - s0) if end else _dt.timedelta(0)
    ws = _parse_when(window_start if len(window_start) > _DATE_LEN else window_start[:_DATE_LEN])[0]
    we = _parse_when(window_end[:_DATE_LEN])[0] + _dt.timedelta(days=1)  # inclusive day
    if len(window_end) > _DATE_LEN:
        we = _parse_when(window_end)[0]
    by_date = {e["date"]: e for e in (exceptions or [])}
    out = []
    for i, d in enumerate(occurrence_dates(s0.date(), rule)):
        if i >= MAX_OCCURRENCES:
            break
        occ_start = _dt.datetime.combine(d, s0.time())
        if occ_start - duration > we and occ_start > we:
            break
        exc = by_date.get(d.isoformat())
        if exc and (exc.get("cancelled") or exc.get("note")):
            continue
        if exc and exc.get("start"):
            st, _ = _parse_when(exc["start"])
            en = _parse_when(exc["end"])[0] if exc.get("end") else st + duration
            moved = True
        else:
            st, en, moved = occ_start, occ_start + duration, False
        last = en if en > st else st
        if last < ws or st >= we:
            continue
        out.append({"date": d.isoformat(), "start": _fmt(st, all_day),
                    "end": _fmt(en, all_day) if end or moved else None,
                    "moved": moved})
    return out


# --- ICS (RFC 5545) mapping --------------------------------------------------------

def to_rrule(rule: dict) -> str:
    parts = [f"FREQ={rule['freq'].upper()}"]
    if rule.get("interval", 1) != 1:
        parts.append(f"INTERVAL={rule['interval']}")
    if rule.get("by_day"):
        parts.append("BYDAY=" + ",".join(rule["by_day"]))
    if rule.get("by_month_day"):
        parts.append(f"BYMONTHDAY={rule['by_month_day']}")
    if rule.get("until"):
        parts.append("UNTIL=" + rule["until"].replace("-", "") + "T235959Z")
    if rule.get("count"):
        parts.append(f"COUNT={rule['count']}")
    return ";".join(parts)


def from_rrule(value: str) -> Tuple[Optional[dict], Optional[str]]:
    """Parse an RRULE into a repeat rule. Returns (rule, unsupported) where
    `unsupported` names parts this format can't hold (e.g. BYSETPOS)."""
    parts = {}
    for p in (value or "").split(";"):
        if "=" in p:
            k, v = p.split("=", 1)
            parts[k.strip().upper()] = v.strip()
    rule = {"freq": parts.pop("FREQ", "").lower()}
    if "INTERVAL" in parts:
        rule["interval"] = parts.pop("INTERVAL")
    if "BYDAY" in parts:
        days = parts.pop("BYDAY").split(",")
        if any(len(d) != 2 for d in days):                 # e.g. 2MO, -1FR
            return None, "BYDAY with positions"
        rule["by_day"] = days
    if "BYMONTHDAY" in parts:
        rule["by_month_day"] = parts.pop("BYMONTHDAY")
    if "UNTIL" in parts:
        u = parts.pop("UNTIL")
        rule["until"] = f"{u[:4]}-{u[4:6]}-{u[6:8]}"
    if "COUNT" in parts:
        rule["count"] = parts.pop("COUNT")
    parts.pop("WKST", None)
    if parts:
        return None, ", ".join(sorted(parts))
    normalized, err = validate_repeat(rule)
    return (normalized, err) if not err else (None, err)
