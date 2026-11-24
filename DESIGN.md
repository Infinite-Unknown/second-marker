# Second Marker — design

## Direction: the answer sheet on the moderator's desk

Second Marker is built from the printed answer sheet a scanner reads: bright white paper, form structure printed in drop-out red ink, marks filled in graphite, a column of black timing marks down the edge, and a scanner light that sweeps the page. Lecturers have handled these sheets for their whole careers. Here the sheet is not decoration: the timing track is the case navigator, the mark bubbles show each mark against its scale, and the scanner sweep is how the app shows it is reading answers.

Physical scene: a module leader at an office desk in daytime, reading marked scripts on a laptop between piles of paper. Light theme only; no dark theme is shipped.

Refused: the edtech default (pastel cards, rounded everything, friendly illustrations) and the "AI tool" default (dark ground, glowing gradient, chat box).

Raised by the directions it was weighed against:

- Centre rail (from a reference-setting page with keys on a centre rail): the two answers in a case sit in twin columns around a centre rail that carries both marks and the gap between them.
- Reserved colour (from orienteering course purple): cobalt belongs only to what is active right now: the current case, the scanner light, focus. Nothing else uses it.
- Hairline seams (from a developer console): inside a sheet, regions split with 1px rules, not shadows; "Start over" stands alone with space around it.
- Live control (from a variable-font specimen): the similarity and mark-gap controls re-judge every case live; the count and the timing track redraw as you drag.
- Visible armature (from a gridded type specimen): the form grid is drawn, not implied; columns and rules line up across the sheet.

## Tokens

### Colour roles

| Token | Value | Role |
|---|---|---|
| `--desk` | `#E5E8E3` | Page ground: the desk the sheets lie on |
| `--sheet` | `#FFFFFF` | Sheets (main surfaces) |
| `--sheet-2` | `#F4F5F2` | Second layer inside a sheet: table heads, rails, wells |
| `--ink` | `#1F2023` | Graphite: body text, filled bubbles, primary button |
| `--ink-2` | `#4A4D52` | Secondary text (8.5:1 on white) |
| `--ink-3` | `#5C6066` | Tertiary text, captions (6.3:1 on white, 5.1:1 on the desk) |
| `--form` | `#E86A55` | Drop-out red: printed form structure (rules, bubble outlines, timing ticks). Never used for small text |
| `--form-text` | `#B23A26` | Form labels and "needs re-mark" text (5.9:1 on white) |
| `--form-wash` | `#FCEDEA` | Highlight behind words that differ between two answers |
| `--scan` | `#2146D8` | Reserved: active case, scanner light, focus ring, live state (7.2:1 on white) |
| `--scan-wash` | `#E8EDFD` | Scanner light wash, words both answers share |
| `--stand` | `#2F6B4F` | "Marks stand" decision (6.3:1 on white) |
| `--rule` | `#D9DBD6` | Hairline seams |

### Type

One family: Archivo (variable, weight and width axes, OFL, self-hosted). Condensed widths are the printed form's voice (labels, column heads, codes); normal width carries reading. Tabular figures everywhere a number appears.

| Step | Size / line | Use |
|---|---|---|
| `--t-xs` | 12 / 16 | Form labels (condensed 75, weight 600, +0.04em, uppercase) |
| `--t-sm` | 13 / 18 | Captions, metadata |
| `--t-md` | 15 / 22 | Body, answers |
| `--t-lg` | 18 / 26 | Answer text in a case, lead copy |
| `--t-xl` | 24 / 30 | Screen titles |
| `--t-2xl` | 34 / 38 | The finding sentence (results hero) |
| `--t-3xl` | 48 / 50 | Landing title only |

### Shape and depth

- Radius: `--r-sheet: 3px` (paper corners), `--r-control: 4px`. Bubbles are true ovals (`border-radius: 50%`, 22 x 14px).
- Shadow (a sheet lying on the desk): `0 1px 1px rgb(31 32 35 / .06), 0 10px 30px -14px rgb(31 32 35 / .22)`. Only sheets cast shadows; nothing inside a sheet does.
- Rules: 1px `--rule`; form rules 1px `--form`.

### Spacing

4-based scale, used for every gap, padding and margin: `--s-1: 4px`, `--s-2: 8px`, `--s-3: 12px`, `--s-4: 16px`, `--s-5: 24px`, `--s-6: 32px`, `--s-7: 48px`, `--s-8: 64px`, `--s-9: 96px`. Sheet padding 32 (24 under 640px). More space above a heading than below it.

## Screens: hero and primary action

| Screen | Hero | Primary action | Secondary |
|---|---|---|---|
| Load | The blank answer sheet: title, one-line promise, the drop area printed as a form box | "Try the sample class" | Choose a CSV file; privacy line |
| Columns | The preview table, each column head labelled with the field it feeds | "Compare answers" | Change a column choice |
| Reading | The sheet being scanned: one line per answer, the scanner light sweeping down, stage list beside it | none (progress) | Cancel |
| Cases | The finding sentence, then the current case: two answers on a centre rail with both marks | Decide: "Needs re-mark" / "Marks stand" | Skip, timing-track navigation, settings |
| Set aside | Look-alike pairs rejected by the meaning check, each with its reason | none | Back to cases |
| Report | The moderation report sheet, anonymised codes | "Download CSV" | Print report |

## Motion

Easing: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` for entrances and feedback; `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` for things moving on screen; linear only for progress. Transform and opacity (plus clip-path for the sweep) only.

| What | Duration | Easing | Notes |
|---|---|---|---|
| Screen enter (sheet rises onto desk) | 320ms | ease-out | translateY(12px) + opacity; first load only staggers the sheet's parts at 40ms |
| Case change (mouse) | 240ms in / 160ms out | ease-out | next case slides 24px from the side it comes from, slight blur(2px) out |
| Case change (keyboard) | 120ms | ease-out | opacity only; keyboard actions are not choreographed |
| Button press | 120ms | ease-out | scale(0.97) |
| Bubble fill on decision | 180ms | ease-out | the chosen bubble fills from scale(0.6); its timing mark fills with it |
| Progress bars | continuous | linear | transform: scaleX |
| Live threshold change | 200ms | ease-out | count crossfades; timing-track marks fade in/out |

Signature moment (the demo's wow): when reading finishes, the scanner light sweeps down the sheet once (clip-path reveal of a cobalt wash, 700ms ease-in-out), the finding sentence lands ("N pairs of students wrote the same answer and got different marks"), and the first case assembles: the two answers rise in from either side onto the centre rail, the words they share are underlined by a sweep left to right, the two mark bubbles fill in graphite, and a red bracket draws between the two marks to show the gap (SVG stroke, 400ms). Total about 1.4s, shown once per analysis.

Reduced motion (`prefers-reduced-motion: reduce`): no sweep, no slides, no bracket draw; everything appears in place with a 150ms opacity fade.

## States

- Empty: the load sheet teaches the expected columns with a printed form header.
- Loading: the reading screen shows model download bytes on first run, then answer counts; never a bare spinner.
- Error: errors name the problem and the recovery (missing column, unreadable mark, model download failed, offline on first run).
- No cases: the finding sentence says so, shows how many pairs were compared and set aside, and offers to loosen the thresholds.
