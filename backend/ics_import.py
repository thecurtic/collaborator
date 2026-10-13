"""ICS (RFC 5545) import: a calendar file becomes PROPOSED events.

UX doc, Events: Collaborator never syncs with Google; it swallows an ICS when
one arrives, and each event becomes a draft the user accepts, the same way
chat-drafted notes are proposed. This module only parses; the caller turns
results into drafts.

Handled: line unfolding, text escapes, DTSTART/DTEND as DATE, UTC (Z),
floating or TZID datetimes (converted to this machine's local wall-clock),
DURATION, LOCATION, DESCRIPTION, RRULE (via recurrence.from_rrule) and
EXDATE (cancelled exceptions). Overrides (RECURRENCE-ID) and rules this
format can't hold are reported, never silently dropped.
"""

import datetime as _dt
import re
from typing import Dict, List, Optional, Tuple

import recurrence

MAX_EVENTS = 200
_TITLE_FORBIDDEN = re.compile(r'[/\\:*?"<>|#^\[\]]')


def _unfold(text: str) -> List[str]:
    out: List[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and out:
            out[-1] += raw[1:]
        elif raw.strip():
            out.append(raw)
    return out


def _unescape(v: str) -> str:
    return (v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
            .replace("\\;", ";").replace("\\\\", "\\")).strip()


def _split(line: str) -> Tuple[str, Dict[str, str], str]:
    """NAME;PARAM=V;...:VALUE -> (NAME, {PARAM: V}, VALUE)."""
    head, _, value = line.partition(":")
    parts = head.split(";")
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.strip().upper()] = v.strip().strip('"')
    return parts[0].strip().upper(), params, value.strip()


def _when(value: str, params: Dict[str, str]) -> Tuple[Optional[str], bool]:
    """ICS date/datetime -> (our ISO string, all_day). Datetimes become local
    wall-clock with this machine's offset (the app's event convention)."""
    v = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", v):
        return f"{v[:4]}-{v[4:6]}-{v[6:8]}", True
    m = re.fullmatch(r"(\d{8})T(\d{2})(\d{2})(\d{2})?(Z?)", v)
    if not m:
        return None, False
    d, hh, mm, _, z = m.groups()
    naive = _dt.datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), int(hh), int(mm))
    if z:
        aware = naive.replace(tzinfo=_dt.timezone.utc)
    elif params.get("TZID"):
        try:
            from zoneinfo import ZoneInfo
            aware = naive.replace(tzinfo=ZoneInfo(params["TZID"]))
        except Exception:
            aware = naive.astimezone()        # unknown zone: treat as local
    else:
        aware = naive.astimezone()            # floating time = local
    local = aware.astimezone()
    off = local.strftime("%z")
    return f"{local.strftime('%Y-%m-%dT%H:%M')}{off[:3]}:{off[3:]}", False


def _duration(value: str) -> Optional[_dt.timedelta]:
    m = re.fullmatch(r"P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?",
                     value.strip())
    if not m or not any(m.groups()):
        return None
    w, d, h, mi, s = (int(x or 0) for x in m.groups())
    return _dt.timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)


def clean_title(summary: str) -> str:
    """A SUMMARY made safe as a note title (filename + wikilink handle)."""
    t = _TITLE_FORBIDDEN.sub(" ", summary or "")
    t = " ".join(t.split()).lstrip(".")
    return t[:180] or "Untitled event"


def parse_ics(text: str) -> Tuple[List[Dict], List[Dict]]:
    """(events, skipped). Each event: {title, start, end, all_day, location,
    description, repeat, exceptions, uid, notes}. `notes` lists what was
    approximated; `skipped` holds {title, reason} for events not importable."""
    events: List[Dict] = []
    skipped: List[Dict] = []
    current: Optional[Dict] = None
    for line in _unfold(text or ""):
        name, params, value = _split(line)
        if name == "BEGIN" and value.upper() == "VEVENT":
            current = {"props": [], "notes": []}
            continue
        if name == "END" and value.upper() == "VEVENT" and current is not None:
            ev = _build(current)
            if "skip" in ev:
                skipped.append({"title": ev.get("title") or "Untitled event",
                                "reason": ev["skip"]})
            else:
                events.append(ev)
            current = None
            if len(events) >= MAX_EVENTS:
                skipped.append({"title": "…", "reason": f"more than {MAX_EVENTS} events; "
                                                        "the rest were not imported"})
                break
            continue
        if current is not None:
            current["props"].append((name, params, value))
    return events, skipped


def _build(raw: Dict) -> Dict:
    props = raw["props"]
    get = lambda n: next(((p, v) for k, p, v in props if k == n), (None, None))
    title = clean_title(_unescape(get("SUMMARY")[1] or ""))
    if get("RECURRENCE-ID")[1]:
        return {"title": title, "skip": "a changed occurrence of a repeating event "
                                         "(import the series, then edit that date)"}
    sp, sv = get("DTSTART")
    if not sv:
        return {"title": title, "skip": "no start time"}
    start, all_day = _when(sv, sp)
    if not start:
        return {"title": title, "skip": f"unreadable start {sv!r}"}
    end = None
    ep, ev = get("DTEND")
    if ev:
        end, _ = _when(ev, ep)
        if all_day and end:
            # ICS all-day DTEND is exclusive; ours is the last day.
            last = _dt.date.fromisoformat(end) - _dt.timedelta(days=1)
            end = last.isoformat() if last.isoformat() > start else None
    elif get("DURATION")[1]:
        dur = _duration(get("DURATION")[1])
        if dur and not all_day:
            s = _dt.datetime.fromisoformat(start)
            e = s + dur
            off = e.strftime("%z")
            end = f"{e.strftime('%Y-%m-%dT%H:%M')}{off[:3]}:{off[3:]}"
    out = {"title": title, "start": start, "end": end, "all_day": all_day,
           "location": _unescape(get("LOCATION")[1] or "") or None,
           "description": _unescape(get("DESCRIPTION")[1] or "") or None,
           "uid": get("UID")[1], "repeat": None, "exceptions": None,
           "notes": raw["notes"]}
    rr = get("RRULE")[1]
    if rr:
        rule, unsupported = recurrence.from_rrule(rr)
        if rule:
            out["repeat"] = rule
        else:
            out["notes"].append(f"its repeat rule uses parts this calendar can't "
                                f"hold ({unsupported}); imported as a single event")
    exdates = []
    for k, p, v in props:
        if k == "EXDATE":
            for one in v.split(","):
                when, _ = _when(one, p)
                if when:
                    exdates.append(when[:10])
    if exdates and out["repeat"]:
        out["exceptions"] = [{"date": d, "cancelled": True} for d in sorted(set(exdates))]
    return out
