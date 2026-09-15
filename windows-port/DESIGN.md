# Attention Dashboard — Design Spec

macOS-inspired frosted-panel dashboard. Calm, glanceable, one accent colour.
Light mode only.

## Tokens

```css
:root {
  --primary: #3b82f6;        /* the only accent — every interactive thing */
  --primary-deep: #2170e4;   /* hover */
  --ink: #191c1d;            /* headings, primary text */
  --ink-2: #424754;          /* body, labels */
  --ink-3: #727785;          /* meta, timestamps */
  --line: rgba(0,0,0,0.05);  /* hairlines */
  --error: #ba1a1a;          /* overdue, destructive */
  --amber-accent: #b75b00;   /* next-event, deadline ≤3 days */
  --teal: #0d9488;           /* "on calendar" tag */
  --glass-border: rgba(255,255,255,0.6);
}
```

Page background: `#f0f2f5` with `linear-gradient(135deg, #fdfbfb, #ebedee)`.
**No `background-attachment: fixed`** — it forces a full-viewport backing layer.

Semantic colour only. Amber = time pressure, rose = overdue/destructive,
green = connected/low-load, teal = calendar-linked. Everything else is neutral
plus the one blue.

Event colours come from Google (`backgroundColor` on each calendar), not from
the palette — so the dashboard matches what the user sees in Google Calendar.

## Typography

- **Windows:** `'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif`
  (macOS build uses `-apple-system, BlinkMacSystemFont, 'SF Pro Text'`).
  Use the platform font. A webfont here looked subtly wrong and cost a request.
- Base 14px / 1.45. Cards 13–13.5px. Meta 11–12px.
- Section titles 17px/600, letter-spacing -0.01em.
- Hero headline 40px/600, letter-spacing -0.03em.
- Eyebrows: 11px, uppercase, `letter-spacing: 0.06em`, `--ink-2`.
- **All numbers** (clock, counts, dates, percentages) use
  `font-variant-numeric: tabular-nums` so they stop jittering.

## Shape and elevation

One radius scale, applied consistently:

| Element | Radius |
|---|---|
| Cards / modals | 16px |
| Inner panels, timeline cards | 12px |
| Inputs, buttons | 10px |
| Chips, small buttons | 6–9px |
| Badges, pills, avatars | full |

```css
.mac-window {           /* every card */
  background: rgba(255,255,255,0.82);
  border: 1px solid var(--glass-border);
  box-shadow: 0 10px 30px rgba(0,0,0,0.08), inset 0 0 0 1px rgba(255,255,255,0.4);
  border-radius: 16px;
}
```

**`backdrop-filter` only where content scrolls underneath**: top header, sticky
schedule bar, dock, toast, modals. On ordinary cards it is invisible (they sit
on a flat gradient) and costs a compositing buffer each — that alone pushed
renderer memory into the gigabytes.

Shadows are tinted toward the background, never pure black.

## Layout

```
┌───────────────── fixed header (blurred) ─────────────────┐
├──────────── main: 8fr / 4fr grid, max 1200px ────────────┤
│  Accounts + calendar toggles │  RSVP (hidden when empty)  │
│  Hero (greeting, clock,      │  Upcoming Schedule         │
│        next-up, donut)       │    (timeline, max 560px,   │
│  Day Briefing                │     sticky header)         │
│  Tasks                       │  Week Ahead                │
└──────────── floating dock, bottom centre ────────────────┘
```

- Single column below 900px; the fixed header hides.
- Card gap 24px, card padding 16–24px.
- Rows separate with hairlines and space, not nested boxes.

## Components

**Dock** — floating pill, 36px buttons, 5px gap. Today · Month | ✚ (primary
circle) | Reload. Active item gets a white fill and a 3px dot beneath.

**Task row** — circular check button (rose ring when overdue), title, meta line,
optional description, optional link, deadline chip, then Edit/✕ that appear on
hover (always visible on touch).

**Deadline chip** — `event` icon + date; `warning` icon + rose when overdue,
amber ≤3 days, neutral otherwise.

**Timeline event** — time in a left gutter, card with a 4px colour bar in the
calendar's colour. In-progress events tint blue with a NOW rule across the
column. Free blocks and pending invites render as dashed italic ghosts.

**Month cell** — Compact: up to 6 coloured dots. Expanded: up to 4 event chips
(coloured left edge, muted time, title) then "+N more". All-day events invert
to a solid colour bar.

**Toast** — dark translucent pill, bottom centre, shrinking progress bar.
The Undo button is hidden when there is nothing to undo.

**Segmented control** — used for Compact/Expanded. Grey track, white raised
pill for the active option.

## Motion

Minimal and functional. 0.15s on hover/opacity, 1s ease on the day donut,
0.2s fade on toasts, a 2s pulse ring on the next-event dot, spinners while
loading. Buttons take `translateY(1px)` on `:active`. Everything collapses
under `prefers-reduced-motion: reduce`.

## Icons

Material Symbols Outlined, weight 300, sized 14–24px. Loaded from Google Fonts
— the only external asset. No emoji in the UI.

## States

Every list needs all four: loading (spinner), empty ("Nothing scheduled",
"No tasks 🎉"), error (inline red, and for calendar failures a banner naming
the calendar, the account, and Google's own message), and populated. Silent
empty-on-error is the failure mode to avoid — it looks identical to a genuinely
free day.

## Copy

Sentence case. Plain and specific: "6 days left", "Overdue by 3 days",
"2 of 7 calendars shown", "not found: C:\Users\…". Name the thing that failed —
a bare "that path no longer exists" wastes the user's time.
