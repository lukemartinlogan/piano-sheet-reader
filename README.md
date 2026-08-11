# Sheet Reader

A MusicXML reader built around one idea: **you shouldn't have to count lines up from the clef to name a note.**

Every staff carries a letter guide in the margin that labels *every* position — lines
and spaces alike — so the column reads as a continuous alphabet:

```
  F ─────────────────────   ← top line
      E                     ← space
  D ─────────────────────
      C
  B ─────────────────────
      A
  G ─────────────────────
      F
  E ─────────────────────   ← bottom line
```

Line letters sit in the outer column, space letters in the inner one. They are
staggered because nine labels across a four-space staff would otherwise collide
— and the split doubles as a cue for whether a note sits on a line or in a
space. Read them together bottom-to-top and you get `E F G A B C D E F`.

The margin guide is **off by default** now that the letters are in the noteheads;
switch it on under Settings → Letter guide, where it can repeat at every barline
or once per line.

**Letters inside the noteheads** — the default reading aid. Each note's name is
printed in its own head, scaled to fit it.

Solid noteheads keep their own black — the notation is left as engraved and the
colour is carried by the letter, in a bright weight so it reads on black. A whole
or half note has no room for that: its centre is a small white hole. There the
colour moves to the note's own outline and the letter is plain black, which is far
easier to read at this size.

Letters are sized to fit *inside* the head. Oversized ones spill past it, hide the
hole that makes a half note read as a half note, and collide with their
neighbours — chord tones a third apart are only one notehead height apart. Hollow heads keep their hole, so note
duration stays readable. Whether a head is hollow is read from the drawn glyph
outline, not from the note's duration — the two disagree on a handful of heads,
and what matters for visibility is what was actually drawn. Rests are left alone;
VexFlow draws them with markup identical to a pitched note, so they are found via
OSMD's model instead.

**Colour coding** (on by default) gives every letter its own hue, shared by the
in-note letters and the margin guide. A colour means the same thing everywhere: C is red
on the treble staff and red on the bass staff, in any octave. **Row highlighting**
(off by default) additionally tints the full-width band behind each staff row.

The guide **extends above and below the staff** as far as the highest and lowest
notes printed in that measure, with the staff lines continued so extended rows
never float. Those continuation rules land on exactly the ledger lines VexFlow
draws for the notes (verified: 1424/1424 match). Extent is computed from where
notes are *printed*, so `8va`/`8vb` brackets are handled.

Letters are a **constant size** everywhere, and the notes always draw on top of
the guide.

The guide follows clef changes, including a clef change part-way along a line.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

The bundled example (`public/examples/`) loads on start. Drag any
`.musicxml`, `.xml`, or `.mxl` file onto the window to open it.

## Features

- **Letters inside noteheads** (default), plus an optional **margin letter guide**
  at every barline or once per line. Each is independently toggleable, along with
  colour coding, row highlighting, and octave numbers.
- **Hide clefs** (Settings → Display) — the guide already names every position,
  so the clef can be dropped to free up room.
- **Playback** with a built-in Web Audio piano — no samples to download, works offline.
  Follows tempo marks including mid-piece changes, and merges tied notes.
- **Practice controls**: tempo from 25–150% without changing pitch, seek, and
  per-hand muting so you can play one hand against the recording.
- **Follow-along**: the sounding measure is highlighted and the page scrolls to keep up.
- **Size** applies on release rather than while dragging — each change re-engraves
  the whole score, and committing per drag step queues dozens of re-renders and
  locks up the page.
- **External MIDI out** (Settings → Sound → Output) when the browser exposes Web MIDI,
  so playback can drive a hardware or OS synth instead of the built-in one.
- Space bar toggles play/pause.

## Layout

```
src/
  score/     MusicXML -> timed note list + per-measure clef map
  render/    geometry read out of OSMD, letter guide, measure highlight
  audio/     Web Audio piano voice, MIDI-out sink, transport/scheduler
  components/  ScoreView (OSMD host) and Toolbar
src/render/noteLetters.ts draws the in-notehead letters
scripts/
  smoke.ts          parse a score in Node and print/validate the result
  verify-render.mjs browser check that the guide aligns with the staff
```

Rendering is [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/); the
letter guide is drawn into OSMD's SVG using positions read from its graphic
model. Those positions are in OSMD units, and the units-to-pixels scale is
**measured from the staff lines the renderer actually drew** (one unit is one
staff space) rather than inferred from the SVG's viewBox. An inferred scale that
is wrong by a factor makes every y drift in proportion to its distance down the
page: the top of the score still lines up while everything below it silently
stops matching, which reads as "only the first few rows have letters". Playback does **not** go through OSMD — `src/score/parseScore.ts` reads
the MusicXML directly, which keeps timing under our control.

## Checks

```bash
npm run typecheck
npm run smoke                       # parser, against the bundled example
npm run build && npm run preview    # then, in another shell:
npm run verify                      # needs Microsoft Edge or Chrome installed
```

`verify` loads the built app in a real browser and asserts that:

- the guide's letters land exactly on the staff lines VexFlow drew (0.00 px error),
- **no letter overlaps a notehead** — the check that keeps the guide honest, since
  OSMD compresses the measure margin while justifying a system, so the space asked
  for is not the space granted; letters shrink to fit rather than collide,
- **every letter printed in a notehead matches that note's pitch** — compared per
  measure against positions the parser read from the file, independently of the
  renderer (247/247 measure-staff groups),
- **no letter is invisible** — each letter's luminance is measured against the head
  it sits on, so a pale letter in a white hole or a dark one on a black head fails
  the build. Colours are applied through `style`, not a `fill` attribute: a
  presentation attribute loses to any CSS rule, which had silently repainted every
  letter white,
- **the notation is not repainted** — noteheads must still carry VexFlow's own
  fills,
- a colour means the same letter on both staves, with 7 distinct hues,
- clef changes are tracked and the guide relabels,
- playback advances, highlights a measure, and pauses.

It writes screenshots to `scripts/out/`.

## Known limitations

- **Repeats are not expanded.** Playback runs straight through; repeat signs,
  codas, and voltas are drawn but not followed.
- **Grace notes are not sounded** (they carry no duration in MusicXML).
- Letters name the staff position, not the key signature — a note on the top
  line in D major is labelled `F`, not `F♯`.
- **OSMD will not reserve space before the first note.** It sits ~2.1 staff spaces
  from the barline whatever `MeasureLeftMargin` is set to — measured across
  0.7 → 24 units, the gap never moved, only the system count (28 → 118). So the
  letters cannot push the notes right; they are sized to fit the room that exists.
  In a handful of unusually tight measures (6 of 276 on the bundled score) the
  letters are dropped for that measure while the coloured rows continue, rather
  than shrinking the letters or overlapping the music.

## Mobile (next step)

The app is web-first but built to wrap: `base: './'` in `vite.config.ts`, a
touch-friendly toolbar, safe-area insets, and an offline synth with no network
calls at runtime. Adding the iOS/Android shells is:

```bash
npm i -D @capacitor/cli && npm i @capacitor/core
npx cap init && npx cap add ios && npx cap add android
npm run build && npx cap sync
```

Note that Web MIDI is not available in the iOS WebView, so the built-in synth is
the only output there.
