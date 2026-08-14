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
`.musicxml`, `.xml`, `.mxl`, `.mid`, or `.pdf` file onto the window to open it.
The format is read from the file's own bytes, so a mislabelled file still opens.

## Two views

**Sheet** is the engraved score described above. **Keyboard** is the same piece
as notes falling onto a piano, striking the keys in time — the reading aid for
when you want to find the note under your hand rather than name it on the page.
The two share a score and a transport, so switching mid-playback keeps your
place, and colour coding means the same thing in both: a red bar lands on a red
`C`. The keyboard is drawn to the pitch range the piece actually uses, rounded
out to whole octaves, so a two-octave piece does not get 88 keys too narrow to
aim at. Scroll the roll to scrub, tap a key to hear it.

Switching views does not re-engrave: the sheet is hidden rather than unmounted,
and hidden by `visibility` so it keeps its width. Hiding with `display: none`
zeroes the container width, and the resize observer then re-lays-out the whole
score on the way back.

## Features

- **PDF import**: open a PDF exported from notation software and it is read back
  into a score — pitches exactly, rhythm as far as it can be verified. See below.
- **MIDI import**: open a `.mid` and it is transcribed to notation — quantised,
  split into two hands, spelled to the key, and beamed. See the limits below.
- **Keyboard view** with falling notes and live key highlighting, toggled in the
  toolbar.
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
             musicXmlWriter.ts  measures + chords -> MusicXML, shared
             midiFile.ts        Standard MIDI File -> notes and meta events
             midiToMusicXml.ts  performance -> notation (see below)
             pdf/pdfContent.ts  PDF -> glyphs and paths, in page coordinates
             pdf/pdfScore.ts    glyphs and paths -> staves, pitches, rhythm
  render/    geometry read out of OSMD, letter guide, measure highlight
             keyboard.ts      piano key geometry, shared by roll and keys
  audio/     Web Audio piano voice, MIDI-out sink, transport/scheduler
  components/  ScoreView (OSMD host), PianoRoll (canvas), Toolbar
src/render/noteLetters.ts draws the in-notehead letters
scripts/
  smoke.ts          parse a score in Node and print/validate the result
  midi-smoke.ts     build a .mid in memory, import it, assert the score
  pdf-smoke.ts      import a real PDF and report how much could be verified
  verify-render.mjs browser check that the guide aligns with the staff
```

Both importers produce MusicXML and hand it to the same loader a dropped
`.musicxml` goes through, so the renderer, the letter guide and the parser stay
unaware that MIDI or PDF exist. That is the whole reason they are converters
rather than second parsers: there is one notation path, and it is the tested
one. What they share beyond that — cutting durations into printable note values
joined by ties, filling gaps with rests, spelling pitches against the key,
beaming runs within a beat — lives once in `musicXmlWriter.ts`. What each keeps
is the part that is genuinely its own: recovering notes from a performance, or
from an engraving.

A MIDI file records *when keys went down*; a score records *what was written*.
Everything between is a guess, and `midiToMusicXml.ts` is where the guessing is
kept — quantising onto a metrical grid, splitting one stream into two hands,
spelling a pitch class as a letter plus an accidental, and cutting held notes
into printable values joined by ties. A file that already separates the hands
(two tracks, or two channels) is taken at its word; anything else is split at
middle C. When the file names no key, one is inferred from a duration-weighted
pitch histogram, which is what keeps a flat key from printing as sharps.

The keyboard view is a canvas, redrawn from `player.position` on each animation
frame rather than from React state — the transport's own clock is the only thing
accurate enough to put a note on a key at the moment it sounds.

## Reading a PDF

A PDF of sheet music is not a picture of music, it is the music's *drawing*. So
unlike a MIDI file, **nothing about pitch has to be guessed**: music fonts follow
SMuFL, where the em square is exactly the height of a five-line staff, so a
clef's own position and size give the staff geometry, and a notehead sits an
exact whole number of half staff spaces from it. Measured over a real 7-page
score, **1710 of 1712 noteheads (99.9%) land exactly on a step**. That property
is what the whole reader is built on — there is no OCR and no model anywhere in
it.

`pdfContent.ts` answers "what did this page draw, and where"; `pdfScore.ts`
answers "what music is that". Staves come from the only long hairline
horizontals on a page, read off in fives with matching gaps. Systems are staves
of matching width close enough to be braced. Barlines are the verticals that run
the system's full height. Noteheads, clefs, accidentals, dots, flags, rests and
time signatures are glyphs; stems, beams and ledger lines are paths.

Three things about pdf.js cost real time and are worth knowing:

- **Glyph positions have to be computed, not read.** The convenience text API
  merges a run into one item with one width, and spreading a run's glyphs evenly
  across it puts every notehead a point or two out — enough that no notehead
  ever finds its own stem, so every beamed note reads as a quarter. Positions
  come from the text matrix and each glyph's own advance instead.
- **Glyphs and paths must share a transform.** Taking text from one API and
  paths from another leaves them in different frames, and every
  glyph-against-path test — staff assignment, stem matching, beam counting —
  silently stops working while pitch still looks perfect. Both are read from the
  operator list in one pass, then flipped once from PDF's y-up to y-down.
- **A path holds several sub-paths.** An engraver draws a whole system's
  barlines as one path object; merging its sub-paths into one bounding box turns
  five thin verticals into one page-wide blob that matches nothing.

Rhythm is the hard half, and it is where the reader is honest rather than
confident. Note *values* are recoverable — the notehead's shape, its dots, its
flags, and the beams crossing its stem — but **onsets are not drawn at all**.
They follow from durations accumulating from the barline, so every bar is laid
out and then checked against its own time signature. A bar that adds up is
almost certainly right. A bar that does not is usually two voices sharing a
staff, so they are separated by stem direction and accumulated independently;
failing that the bar is spaced by where the engraver put things, which is never
exact but never nonsense. The app reports the split rather than hiding it.

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
npm run midi                        # MIDI import, against a built-in fixture
npm run pdf -- "some/score.pdf"     # PDF import, against a real PDF
npm run build && npm run preview    # then, in another shell:
npm run verify                      # needs Microsoft Edge or Chrome installed
npm run verify -- http://localhost:4173/ --pdf "some/score.pdf"
```

`pdf` has no bundled fixture on purpose: writing a PDF by hand the way
`midi-smoke` writes a MIDI file would mean writing an engraver first, and a
fixture drawn by this project would only prove it can read its own output. So it
runs against a real PDF, asserts what must hold of any engraving — staves in
pairs, bars that divide, right hand above left, every pitch on a keyboard — and
prints the number that actually matters:

```
RHYTHM   bars that add up exactly: 29/81  (35.8%)
         sum/expected p10 0.79  median 1.00  p90 1.17
```

The distribution is the debugging tool. Consistently over means note values are
read too long (beams being missed); consistently under means notes are missed
outright; a median that is not 1.00 usually means the time signature is wrong.

`midi` writes a Standard MIDI File byte by byte, imports it, and asserts the
score that comes out: the fixture is hand-written rather than sampled so the
expected answer is known exactly. It checks the things import is most likely to
get wrong — the split into two hands, bar lengths across a metre change, tempo
changes landing on the right beat, a whole note surviving as one note rather
than four tied quarters, F sharp spelled as F rather than G flat (and carrying
no accidental, since it is in the key), eighth runs beamed rather than flagged,
and **every bar filled to exactly its own length on every staff** — a short bar
is the one error that breaks OSMD's layout rather than merely looking wrong.
It leaves the fixture and the generated notation in `scripts/out/`.

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
- playback advances, highlights a measure, and pauses,
- the **keyboard view** sizes its canvas, fits the key range to the score, paints
  more than a flat field (the pixels are read back — a canvas that draws nothing
  still passes every DOM check), lights keys while playing, sounds a tapped key
  without moving the transport, and leaves the sheet un-re-engraved on the way
  back,
- a **`.mid` dropped into the running app** comes out engraved by OSMD, with
  every printed letter matching the pitch the parser read — the same
  cross-check as the first phase, run against notation this app generated
  rather than notation it was handed,
- a **`.pdf`**, when one is supplied, opens without error, is engraved, gets its
  letters, and reports what it could verify. This phase is the only thing that
  exercises the pdf.js worker, which Node never touches.

It writes screenshots to `scripts/out/`.

## Known limitations of PDF import

**Pitch is reliable. Rhythm is partial, and the app says so** — the banner after
an import reports how many bars were verified against their own time signature.
On the 7-page score this was built against: 81 bars, 1886 notes, clefs, key,
metre (including a 12/8) and tempo all read correctly, hands correctly
separated, every pitch on the keyboard — and **36% of bars verified exactly**,
the rest spaced by position. Expect the letter guide and the keyboard view to be
trustworthy on a PDF, and playback to drift in the bars that could not be
verified.

- **Only vector PDFs exported from notation software.** A scan or a photo needs
  real optical recognition, which this is not; it will report that it cannot
  find any staves rather than guessing.
- **Two voices on one staff are merged.** They are separated by stem direction
  only when that makes the bar add up; otherwise they are flattened into one
  line, and inner voices lose their independence.
- **Ties are drawn but not followed.** A tied note is re-struck rather than held,
  because a tie is a curve on the page and telling it from a slur means matching
  its ends to noteheads of the same pitch.
- **Grace notes, tuplets and repeats are not read.** Tuplet brackets in
  particular will not add up, so those bars fall back to positional spacing.
- Nothing decorative is read: dynamics, articulations, pedal, fingering, 8va.

## Known limitations of MIDI import

A performance is not notation, and these are the places the guess shows. None of
them affect a `.musicxml` file, which carries the answers.

- **Everything is quantised to sixteenths.** Triplets and swing are rounded onto
  the binary grid, so a triplet passage comes out as sixteenths. Tuplet notation
  (`<time-modification>` plus brackets) is the next step, not a tweak.
- **One voice per staff.** Simultaneous notes become a chord; a note held under a
  moving line is clipped at the next onset in that hand rather than getting its
  own voice. The chord takes the length of its longest member, so harmony rings
  rather than clipping.
- **A tempo map is preserved but rarely printed.** Every tempo change drives
  playback, which is what makes quantised notes sound human again; only a sparse,
  authored-looking map (32 marks or fewer) also gets a printed metronome mark.
- **Percussion is dropped** — channel 10's "pitches" are drum names.
- **Everything lands on one grand staff.** A multi-instrument file is merged into
  two hands rather than becoming one part per instrument.
- Whole empty bars of lead-in are trimmed, since sequencers add them as a
  count-off. A genuine pickup bar written as silence goes with them.

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
