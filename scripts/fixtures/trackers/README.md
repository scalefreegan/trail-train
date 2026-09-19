# Tracker fixtures

Committed pages that `scripts/trackers.test.mjs` parses instead of the
network. **No test in this repo may fetch a tracker.** Every adapter takes a
`fetchImpl`, and the tests hand it a function that returns one of these files.

## opensplittime-spread.html

- **Origin.** `https://www.opensplittime.org/events/2026-san-juan-softie-100/spread`,
  fetched once by hand on 2026-09-19 (HTTP 200, 253 892 bytes). That URL is
  the `links.results` of `races/san-juan-softie-100-2027/race.json`, which is
  why this event and not another.
- **What it is.** OpenSplitTime's "spread" view: one server-rendered table,
  one row per entrant, one column per aid station, with `In / Out` times.
  It needs no JavaScript — the first GET carries every split.

### Scrub

The live page listed 98 real entrants by name, bib, gender, home state and a
per-runner `/efforts/<event>-<first>-<last>` URL. None of that is in the
committed file. The scrub, applied before the first commit:

- **93 of the 98 rows were deleted outright.** Four remain.
- **Every remaining runner was renamed and re-bibbed**, and their `<tr
  id="effort_…">`, `data-watch-row-effort-id-value` and `/efforts/…` link were
  replaced with synthetic ids in a 900000 block:

  | row | name | bib | status | why it is kept |
  |---|---|---|---|---|
  | 1 | `TEST RUNNER` | `999` | in progress (blank) | the happy path: last checkpoint is **Burnett #7**, out at `Fri 9:22PM`. Its tail columns were also blanked to placeholders, so the row is mid-race rather than a real finisher's. |
  | 2 | `Entrant Two` | `902` | `Finished` | a complete row, finish time with seconds (`Sat 5:28:32AM`) and an overnight day rollover |
  | 3 | `Entrant Four` | `904` | `Dropped` | a DNF: last real time is an **in**-time with no out (`Sat 8:00AM / --:--:--`), and one earlier cell is `--:--:-- / …` (a missed in-time) |
  | 4 | `Entrant Three` | `903` | `Not Started` | every cell a `--:--:--` placeholder |
- **Gender is forced to `Male` and the "From" column emptied** on all four, so
  no demographic detail survives even in aggregate.
- **The `csrf-token` meta was replaced with `SCRUBBED`.**
- Everything else — head, nav, scripts, CSS links, the `<thead>` with the 13
  real station names and miles, the table markup — is byte-for-byte the page
  OpenSplitTime served, because the parser's job is to find the table amid
  exactly that noise.

Only the split TIMES are real, and they are now attached to invented people.
The station names and miles are the Softie's published course, which is
public on the race site.

### Re-capturing it

If OpenSplitTime redesigns and the parser needs a newer sample:

```sh
curl -sL -o page.html "https://www.opensplittime.org/events/<event-slug>/spread"
```

then redo the scrub above before committing. Keep the four row archetypes —
mid-race, finished, dropped-with-a-missing-in-time, not-started — since each
one is a test.

## MAProgress

**No fixture, on purpose.** `scripts/trackers/maprogress.mjs` is a documented
stub; its header records what was checked on 2026-09-19 (no public Softie
event URL exists, and `app.maprogress.com` renders from a SignalR websocket
after load, so its first response carries no checkpoint data). There is
nothing static to save. When a public event URL is issued, capture it — and
the XHR/websocket traffic its map subscribes to — and add the fixture here.
