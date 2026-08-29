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
npm run ios        # build and copy into the iPad shell (see below)
```

The bundled example (`public/examples/`) loads on start. Drag any
`.musicxml`, `.xml`, `.mxl`, `.mid`, or `.pdf` file onto the window to open it.
The format is read from the file's own bytes, so a mislabelled file still opens.

There is also an **iPad app** — the same bundle, offline, with an on-device
score library and touch gestures. See [The iPad app](#the-ipad-app).

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
- **An iPad app**, fully offline, with an on-device score library, scores opened
  from Files/Mail/AirDrop, drag-to-scrub and pinch-to-resize.

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
  native/    the iPad shell's half: score library on disk, files iOS hands over
             platform.ts      the one check everything native hides behind
  components/  ScoreView (OSMD host), PianoRoll (canvas), Toolbar, Library
src/render/noteLetters.ts draws the in-notehead letters
ios/         the Capacitor Xcode project (committed; see The iPad app)
scripts/
  smoke.ts          parse a score in Node and print/validate the result
  midi-smoke.ts     build a .mid in memory, import it, assert the score
  pdf-smoke.ts      import a real PDF and report how much could be verified
  verify-render.mjs browser check that the guide aligns with the staff
  make-app-art.mjs  draws the app icon and launch image from the palette
  fix-spm-paths.mjs repairs Package.swift after a sync run on Windows
```

`src/native/` is the only part of the app that knows an iPad exists, and every
entry point into it is behind `isNative()`. The web build runs the same bundle
with those paths dead, which is why the render check still covers both.

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

`verify` also asserts that the running app makes **no request off its own
origin**, which is what keeps the offline claim honest.

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

## The iPad app

The same bundle, wrapped in a [Capacitor](https://capacitorjs.com) shell, in
`ios/`. There is no `server.url` in `capacitor.config.ts` and nothing is fetched
at runtime: the WebView loads `dist/` out of the app bundle, the engraver, the
importers, the example score and the synth are all in there, and the app behaves
identically in airplane mode. That is checked rather than claimed — see
*Offline* below.

### Building it

The Xcode project is committed, because its document types, icon, launch screen
and audio-session setup are hand-set and `npx cap add ios` would regenerate them
as the template's defaults. So there is nothing to scaffold:

```bash
npm install
npm run ios          # build the web app, copy it into the shell
npm run ios:open     # open ios/App/App.xcodeproj in Xcode   (macOS only)
```

Then pick an iPad (or a simulator) and press Run. `npm run ios` is safe to run on
any platform; opening and building are macOS-only, and Xcode resolves the Swift
packages on first build, which is the one step that wants a network.

`npm run ios` ends by rewriting the local package paths in the generated
`CapApp-SPM/Package.swift`. Capacitor writes them with the host separator, so a
sync run on Windows emits `path: "..\..\node_modules\@capacitor\app"` — wrong
separator, and `\n` inside a Swift string literal is a newline, so the path does
not survive as text. `scripts/fix-spm-paths.mjs` puts them back to POSIX, which
Swift Package Manager wants on every platform.

The app icon and launch image are generated too, from the app's own palette, so
the mark on the home screen is the same three coloured noteheads the score is
drawn with:

```bash
npm run app-art      # needs Edge or Chrome, like npm run verify
```

### Offline

Nothing in the app talks to the network — no fonts, no CDN, no analytics, no
sample library. The piano is synthesised, and the only thing ever fetched is the
bundled example, from the app's own bundle.

`npm run verify` asserts it: every request the running app makes is watched, and
any URL that is not the app's own origin fails the check. A stylesheet or font
that only ever loaded because the dev machine happened to be online would not
show up in any other test here — it would show up as a blank screen on a plane.

### Getting scores in

An iPad has no window to drag a file onto, so the app keeps a **library**: a
plain `Scores` folder in its own Documents, listed in the toolbar under Library.
Anything opened is copied there and stays; the app reopens whatever you last had
on screen, so closing it between practice sessions comes back to the piece
rather than to the demo. `UIFileSharingEnabled` puts that folder in the Files app
under *On My iPad → Sheet Reader*, so the library is a real folder you can add
to, rename in, and back up — not a private database you cannot see.

Scores arrive three ways:

- **Add a score…** in the Library, which is the system document picker. It
  carries no `accept` filter in the shell on purpose: iOS filters the picker by
  UTI, and one type it does not recognise greys out every score on the device.
  The format is read from the file's own bytes anyway.
- **Open in Sheet Reader** from Files, Mail, Messages or AirDrop. `Info.plist`
  declares the four document types, and MusicXML — which has no system UTI — is
  declared as an *imported* type (`com.recordare.musicxml`, and a `.compressed`
  variant conforming to zip for `.mxl`) so iOS knows what one is without the app
  claiming to own it. PDF is registered `Alternate`, never `Owner`: this reads
  engraved PDFs, it is not a PDF viewer, and it should not displace Books.
- **Drag and drop** from another app in Split View, which arrives as an ordinary
  HTML drop and goes through the same path the desktop does.

`LSSupportsOpeningDocumentsInPlace` is deliberately **false**. An in-place URL is
security-scoped and lives outside the sandbox, where the file bridge cannot read
it without claiming that scope; with it off, iOS drops a readable copy in
`Documents/Inbox`, which the app files into the library and then deletes. A
reader that never writes back to your file loses nothing by taking the copy.

A file is filed only once it has *parsed*. A file the app cannot read is not a
score, and putting it in the library would make it a permanent one.

### Touch

- **Drag the roll to scrub.** The keyboard view is a timeline and there is no
  wheel, so it is dragged instead. The roll follows the finger — a note under it
  stays under it — which means dragging down runs time forward, the direction
  the notes fall. Below the strike line the keys still play.
- **Pinch to resize the score.** Re-engraving costs seconds on a long piece, so a
  pinch cannot re-render as it moves any more than the Size slider can: the
  gesture scales the drawn SVG for feedback and commits the real size once on
  release, re-engraving at that size rather than leaving a scaled bitmap. The
  transform's origin is the point between the fingers, so the bar being read
  stays under them.
- The page itself never zooms, controls get finger-sized targets on any coarse
  pointer, and long-press selection is suppressed over the score so grabbing a
  page does not grab a notehead.
- Safe-area insets are honoured on all four edges — the home indicator would
  otherwise sit over the piano keys, which are at the very bottom of the
  keyboard view and are meant to be tapped.

### Sound

`AppDelegate` sets the audio session category to `.playback`. A WKWebView's Web
Audio defaults to `ambient`, the category for sounds the system may silence, so
the piano would be inaudible whenever the iPad is muted. The session is
categorised but not activated at launch: activating it would stop whatever else
is playing before the user has asked for a single note.

**Web MIDI does not exist in the iOS WebView**, so Settings → Sound → Output has
only the built-in piano there. Everything else — both views, both importers, the
letter guide, playback, per-hand muting — works the same as on the web.

### What has not been checked

Everything above is built and syncs, the web bundle it wraps passes the full
render check, and the library's save/list/reopen/remove path was exercised
end-to-end against Capacitor's filesystem. But **the Xcode build and a run on
real hardware have not happened** — that needs a Mac, and this was developed on
Windows. Expect the first `Run` to want a signing team selecting, and treat the
touch gestures and the Files integration as designed-but-unflown until they have
been used on a device.
