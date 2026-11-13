# Petree design system: "Handheld Arcade"

**Status:** agreed 2026-11-13 (variant C1 world, moved to a light handheld look).
**Mockups:** [Arcade canvas](https://claude.ai/artifact/4oB5gNGZSjgE4v7ATMMSHs):
Inbox, InboxDark, Thread, Running, Reader, Victory, New, Settings, MobileInbox,
MobileThread. Treat the canvas as the picture and this doc as the contract; where
they disagree, this doc wins.
**Spec:** `docs/superpowers/specs/2026-11-13-petree-thread-inbox-design.md`.

## 1. World and voice

Petree is a pocket game console. A pale grey plastic **shell** frames an off-white
LCD **screen**. Threads are **quests**, the agent's party works them, the user
makes **moves**. Pixel display type for words you glance at, a calm readable face
for words you read.

- Arcade words are the label; a plain-English subline under every action says
  what actually happens. Never an arcade word alone on a button.
- Calm, not loud: no pure black, no pure white, every text colour ≥ 4.5:1 on its
  background. Light is the default; a **muted dark** mode follows
  `prefers-color-scheme` (slate, soft, never pitch black).
- Three colours, one job each: **magenta = needs you**, **green = running/done**,
  **amber = rewards and the primary action**. Magenta is never decoration.
- State is never told by colour alone: always a word too (YOUR MOVE!, QUESTING…).

## 2. Tokens

| token | light | dark | use |
|---|---|---|---|
| `--shell` | `#E4E5DF` | `#2A2E38` | page background |
| `--screen` | `#F6F6F1` | `#343946` | cards, panels |
| `--inset` | `#ECEDE6` | `#2F3440` | wells, inputs, doc bodies |
| `--line` | `#C9CBC1` | `#4A5062` | borders, rules |
| `--line-strong` | `#A9AC9F` | `#5C6378` | pixel frames |
| `--ink` | `#363B47` | `#E4E2D8` | main text |
| `--muted` | `#5E6472` | `#B3B7C4` | secondary text |
| `--label` | `#6B7180` | `#9DA2B2` | small labels |
| `--need` | `#B8327A` | `#F28CC0` | needs-you text, count |
| `--need-tint` | `#F7E3EE` | `#4A3445` | needs-you fills |
| `--need-frame` | `#B8327A` | `#B5608F` | needs-you frames/borders |
| `--go` | `#3D7A2A` | `#A8D877` | running/done text |
| `--go-fill` | `#7DB84A` | `#7DB84A` | bars, lit pixels, switch ON (non-text) |
| `--go-tint` | `#E3EFD9` | `#36452F` | |
| `--gold` | `#9A5B00` | `#F5B95E` | XP, level, trophies, selected frame |
| `--gold-fill` | `#F2A93B` | `#E0A64E` | primary button bg (ink text on it) |
| `--gold-tint` | `#FBEBD0` | `#4A4030` | selected tile bg |

**Dark needs-you is soft:** never a solid `#F28CC0` block. Dark = `--need-tint`
background + `--need` text + `--need-frame` border. Light keeps the inverted
label (magenta block, screen-coloured text).

**Texture:** light screens carry a faint LCD pixel grid (3 px cells, ink at ~5%
opacity), as a CSS background:
`url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%223%22 height=%223%22%3E%3Cpath d=%22M0 2.5H3M2.5 0V2.5%22 stroke=%22%23363B47%22 stroke-opacity=%220.05%22/%3E%3C/svg%3E')`.
Dark screens use faint scanlines instead:
`repeating-linear-gradient(180deg, rgba(228,226,216,.03) 0 1px, transparent 1px 3px)`.

**Repo hues** (emblem pixels and repo chips). Known repos map to a fixed hue; any
other repo name hashes (§4.2 hash) into this palette. Dark values are lightened
so they read on `--inset`; check contrast for the last three before use.

| light | dark | seen on |
|---|---|---|
| `#5B6CC9` | `#8F9BE6` | petree |
| `#C2582E` | `#E88A63` | druid-connector |
| `#2E8C86` | `#5EC2BB` | kubtru |
| `#8A55B8` | `#B98BE0` | flowengine |
| `#6E8A1F` | `#A3C25A` | popplank |
| `#4F7FA8` | `#8DB4D9` | — |
| `#7A6A3A` | `#C2AE78` | — |
| `#3E86B5` | `#7FBCE3` | — |

## 3. Type

| face | where | sizes |
|---|---|---|
| **Jersey 10** (Google Fonts) | headings, labels, numbers, button words, levels, Q-numbers | only 20 / 30 / 40 / 50 px (and 100 px for VICTORY!) so pixels land whole |
| **Atkinson Hyperlegible** 400/700 | everything you read: titles, summaries, actions, comments, markdown, sublines | 13–19 px body; button sublines 13 px 700 |
| **IBM Plex Mono** 400 (optional) | commands, paths, ids | 13–14 px |

## 4. Components

All shapes use **pixel-stepped corners** via `clip-path`, never `border-radius`.
Small step (4 px), used on buttons, chips and tiles:

```
polygon(0 4px,4px 4px,4px 0,calc(100% - 4px) 0,calc(100% - 4px) 4px,100% 4px,100% calc(100% - 4px),calc(100% - 4px) calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,4px calc(100% - 4px),0 calc(100% - 4px))
```

A 2 px "stepped border" is an outer element filled with the frame colour, 2 px
padding, and an inner element with the same clip-path filled with the surface.

### 4.1 Cartridge card

The inbox card and every panel. `--screen` fill with the LCD texture, 2 px
`--line-strong` stepped frame (needs you: `--need-frame`). Top-right gets a
bigger 3-step cut (6 px steps from 18 px in), the other corners single 4 px
steps:

```
polygon(0 4px,4px 4px,4px 0,calc(100% - 18px) 0,calc(100% - 18px) 6px,calc(100% - 12px) 6px,calc(100% - 12px) 12px,calc(100% - 6px) 12px,calc(100% - 6px) 18px,100% 18px,100% calc(100% - 4px),calc(100% - 4px) calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,4px calc(100% - 4px),0 calc(100% - 4px))
```

Optional connector strip under the bottom edge: 5 px dashed amber
(`rgba(242,169,59,.45)`, 7 px on / 4 px off), offset left of centre.

Card content, top to bottom: emblem + Q-number; title (one line, ellipsis);
summary (2-line clamp); YOUR MOVE! block with the action line, or QUESTING… block
with elapsed time and a 16-cell trail; level track; repo chips + tags; age.
Prompts are never shown on cards. The whole card is one link.

### 4.2 Quest emblem and Q-number

A 5×5 mirror-symmetric pixel glyph, 6 px per pixel, in a 4 px `--inset` well
with a 2 px `--line` border. Same thread → same emblem on every screen.

```js
// FNV-1a + murmur3 fmix32
const hash = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h >>> 0
}
// 15 bits → 5 rows × 3 columns, mirrored to 5 columns. true = lit pixel.
const emblem = (threadId) => {
  const h = hash(threadId)
  let bits = h & 0x7fff, count = 0
  for (let b = bits; b; b >>>= 1) count += b & 1
  if (count < 8) bits |= (h >>> 15) & 0x7fff // sparse glyphs don't read at a glance
  const cells = []
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) cells.push(((bits >>> (y * 3 + Math.min(x, 4 - x))) & 1) === 1)
  return cells
}
```

Input is the **thread id** (the mockups hashed the Q-string as a stand-in). Lit
pixels take the hue of the thread's first repo (§2); unlit pixels take
`--shell`. Beside it, the **Q-number** in Jersey 30: `Q-021`, zero-padded to 3.

### 4.3 Level track

Five pixel nodes joined by pixel dashes: **SCOUT · PLAN · CRAFT · SHIP · VICTORY**
(= investigate · spec · build · PR open · merged).

- done: `--go-fill` square with a pixel check, solid segment after it.
- current: larger, 1 px halo; amber when running, `--need` when it needs you.
- todo: dashed `--line-strong` outline, dashed segment.
- skipped: like todo, with the number struck.

Beside or under it, small Atkinson: real stage name, `PLAN · spec`, and
`LV 2/5`. Provide an `aria-label` sentence ("Level 2 of 5: PLAN, the spec stage,
waiting for you").

### 4.4 Labels

- **YOUR MOVE!** light: magenta block, screen text, pixel ▶ before, solid cursor
  block after. Dark: soft variant (§2).
- **QUESTING…** `--go` text, hollow cursor block, elapsed `12 MIN` beside it.
- **Count chip** (header, section titles): Jersey 30 number in a stepped square;
  magenta for YOUR MOVE, `--go-fill` with ink for QUESTING.
- Repo chip: `name · tag`, repo hue dot, Atkinson 13 px.

### 4.5 Buttons

Every button is a Jersey word plus an Atkinson 13 px subline. Touch target
≥ 44 px (primary ≥ 52 px).

| kind | look | example |
|---|---|---|
| primary | `--gold-fill` bg, ink text, small step corners | `CONTINUE ▶` / "approve spec · start build" |
| secondary | `--screen` bg, 2 px `--line-strong` stepped frame | `RETRY STAGE` / "send comment · rewrite spec" |
| quiet destructive | text only, `--muted` | `GAME OVER` / "drop to the bin" |

One primary per view. Sublines name the real effect, using the real stage name.

### 4.6 Selection tile

The only pick control (repos, starting level, model, tag filters inside forms).
No native radio or checkbox is ever visible; the real `<input>` sits inside the
`<label>` visually hidden (opacity 0, 1 px) so keyboard and screen readers work.

- off: `--screen` bg, 2 px `--line-strong` stepped frame, 16 px pixel square
  (`--line-strong` frame, empty) at the left.
- on: `--gold-tint` bg, 2 px `--gold` frame, the square in `--gold` with a pixel
  check.
- Content: Jersey 30 word (+ Jersey 20 tag like `LV 1`), Atkinson 14 muted line.
- Multi-choice = checkboxes; single-choice = same tile in a `role="radiogroup"`
  with radios.

Header tag filters (ALL / WORK / PERSONAL) are a segmented group instead: inset
well, active segment ink-filled with screen text, `aria-pressed`.

### 4.7 Pixel switch

For on/off settings. A `<button role="switch" aria-checked>` row: Jersey 30 name,
Atkinson 14 line, then the switch on the right: word + a 2-cell track (2 px
`--line-strong` frame, `--inset` bg, 22 px cells).

- ON: `ON` in `--go`, knob in the right cell, `--go-fill`.
- OFF: `OFF` in `--muted`, knob in the left cell, `--screen` with a 2 px frame.

### 4.8 Long-text clamp and reader popup

**Long text never grows a section.** Any markdown, doc, log, prompt or comment
block shows at most ~10 lines: `max-height: 260px` desktop, `200px` phone,
`overflow: hidden`, with a fade into the panel colour over the last ~48 px. When
(and only when) the content overflows, show a secondary button `READ ALL ▶` /
"open in the reader · 2,140 words" (or "· 40 lines" for prompts). Measure with
`scrollHeight > clientHeight` after render.

The **reader** is a modal over the current screen (native `<dialog>` or the
existing overlay): head with Q-number, doc name and path, `630 WORDS · 3 MIN`
(230 wpm), `CLOSE` (and Esc). A CONTENTS list built from the doc's headings sits
beside the text on desktop, above it on phone. When the doc is the gate document,
the gate buttons repeat at the bottom (CONTINUE / RETRY STAGE / GAME OVER), so the
user can decide without closing.

### 4.9 Stats tiles

QUEST STATS is a grid of tiles: Jersey 20 label (`TIME PLAYED`), Jersey 40 value
(`1H 12M`), Atkinson 13 muted subline ("agent time, 2 stages"). `MAX WINDOW` adds
a 10-cell meter. A running turn shows a `LIVE` tag and its numbers tick. Below:
a PER STAGE table (stage, model, time, tokens in/out, turns, window), TOP TOOLS
as `Read 120 · Grep 38 · Bash 22`, and FILES CHANGED · TEST RUNS lines. Values
marked as estimates carry `≈`.

### 4.10 HUD header (one header everywhere)

Left: Sprout + `PETREE` wordmark (Jersey 40), a link to the inbox. Then HUD (LV
block, XP bar of 5 cells, streak flame), the YOUR MOVE count chip (links to the
section), tag filters, `PRESS START` / "start a new thread", and the gear. No
screen moves the logo or uses a slimmer header. Page titles (NEW QUEST, OPTIONS,
Q-021) go in `<main>` under a `BACK` button.

**Gear** (12×12, drawn at 24 px, `fill="currentColor"`, in a 52 px inset square
with a 2 px frame, `aria-label="Settings"`):

```html
<svg aria-hidden="true" width="24" height="24" viewBox="0 0 12 12" shape-rendering="crispEdges" fill="currentColor">
  <rect x="4" y="0" width="4" height="1"/><rect x="1" y="1" width="2" height="1"/><rect x="4" y="1" width="4" height="1"/><rect x="9" y="1" width="2" height="1"/>
  <rect x="1" y="2" width="10" height="1"/><rect x="2" y="3" width="8" height="1"/>
  <rect x="0" y="4" width="5" height="1"/><rect x="7" y="4" width="5" height="1"/><rect x="0" y="5" width="4" height="2"/><rect x="8" y="5" width="4" height="2"/><rect x="0" y="7" width="5" height="1"/><rect x="7" y="7" width="5" height="1"/>
  <rect x="2" y="8" width="8" height="1"/><rect x="1" y="9" width="10" height="1"/>
  <rect x="1" y="10" width="2" height="1"/><rect x="4" y="10" width="4" height="1"/><rect x="9" y="10" width="2" height="1"/><rect x="4" y="11" width="4" height="1"/>
</svg>
```

### 4.11 Sprout

The pixel knight mascot, one sprite on a 16×17 grid (`shape-rendering="crispEdges"`),
3 px per pixel in the header, 8 px on Victory. Colours: leaf `#7DB84A`/`#3D7A2A`,
armour `--line-strong`, visor ink, joints `--muted`, **scarf always amber**
(`#9A5B00` / `#F2A93B`), never blue. Poses by situation:

| pose | when |
|---|---|
| idle | nothing needs you |
| waving (one arm raised) | ≥ 1 thread needs you |
| sword-up | Victory |

The canonical rect grids are in the canvas: waving in `ArcadeInbox` (header),
sword-up in `ArcadeVictory`, idle in `QuestArcade`. Copy them; don't redraw.
Every Sprout has `role="img"` and an `aria-label` naming the pose.

### 4.12 Bins

- **GAME OVER**: collapsed section at the bottom of the inbox with a count.
  Rows greyed, with emblem, Q-number, title and reason ("dropped by you", "out of
  tokens", "failed: tests"), age, repo, and a secondary `CONTINUE?` / "restore
  from the bin". Note: "Cleared after 14 days."
- **HALL OF FAME**: a shelf of pixel trophies with emblem, title, outcome
  ("merged · PR #15") and age. Note: "Merged quests rest here for 3 days, then
  move to history."

## 5. Phone (390 px)

Every screen works at 390 px; no separate app.

- Header wraps to two rows: Sprout + PETREE + YOUR MOVE chip + gear on row 1;
  filters + PRESS START on row 2. The HUD's LV/XP/streak may drop on phone.
- Cards one column (`grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr))`).
- Long text clamps at 200 px.
- Thread page order on phone: head, YOUR MOVE line, document (clamped), earlier
  docs, quest log (collapsed to its last line), prompt, stats (headline tiles
  plus `MORE STATS`), note box, then the action buttons.
- Touch targets ≥ 44 px; page container `max-width: 1160px`, 16 px side gutter on
  phone, no horizontal scroll.

## 6. Vocabulary

| arcade | plain meaning | where |
|---|---|---|
| quest | thread | everywhere |
| Q-021 | thread's sequence number | cards, titles |
| SCOUT / PLAN / CRAFT / SHIP / VICTORY | investigate / spec / build / PR open / merged | level track |
| LV 2/5 | current step of the five | cards |
| YOUR MOVE | needs you | inbox section, label, header chip |
| QUESTING… | running | inbox section, label |
| PRESS START | new thread | header, empty states |
| CONTINUE ▶ | approve → next stage (or open the PR after CRAFT) | gate |
| RETRY STAGE | comment and revise the same stage | gate |
| SHIP IT | open the PR | after CRAFT |
| PAUSE | stop the running turn | running thread |
| RESUME | re-run a paused or stopped turn | paused thread |
| QUEUE NOTE | add a comment for the next turn | running thread |
| GAME OVER | drop to the bin / the bin itself | gate, inbox |
| CONTINUE? | restore from the bin | GAME OVER row |
| HALL OF FAME | merged threads, last 3 days | inbox |
| READ ALL ▶ | open the reader popup | clamped blocks |
| SAVE / BACK / DONE / CANCEL | save settings / leave / close editor keeping edits / undo edits | options |
| RECRUIT REPO / DISMISS | add a repo / remove it from repos.yaml | options |
| PARTY | the repos a quest works in | new quest |
| PARTY MODE | allow subagents | new quest |
| AUTO-PLAY | skip gates until the PR is open; never merges | new quest |
| SAGE · Opus | "deep thinking, slower" | model tile |
| KNIGHT · Sonnet | "balanced, the default" | model tile |
| ROGUE · Haiku | "quick and cheap" | model tile |
| YOUR NOTE TO THE PARTY | the comment box | thread |
| QUEST LOG | timeline of turns, approvals and comments | thread |
| QUEST STATS | effort and cost | thread |
| OPTIONS / PARTY ROSTER / GAME RULES | settings / repos / defaults and retention | options |
| XP, LV, streak | cosmetic counters of merged quests | header, Victory |

Model class names are not level names: SCOUT is a level, so the Haiku class is
ROGUE.
