import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScoreView } from './components/ScoreView';
import { PianoRoll } from './components/PianoRoll';
import { Toolbar, type ViewMode } from './components/Toolbar';
import { loadMusicXml, type ScoreSource } from './score/loadMusicXml';
import { parseScore } from './score/parseScore';
import type { ParsedScore } from './score/types';
import { DEFAULT_GUTTER, type GutterOptions } from './render/letterGutter';
import { measureAt } from './render/highlight';
import { Player, listMidiOutputs } from './audio/Player';
import type { MidiOutputLike } from './audio/PianoSynth';

const EXAMPLE_URL = `${import.meta.env.BASE_URL}examples/elden-ring-ost-the-final-battle-tsukasa-saitoh.mxl`;

interface Loaded {
  xml: string;
  score: ParsedScore;
  filename: string;
  source: ScoreSource;
}

export default function App() {
  const playerRef = useRef<Player | null>(null);
  if (playerRef.current === null) playerRef.current = new Player();
  const player = playerRef.current;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** How an import went, when that is worth saying out loud. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [gutter, setGutter] = useState<GutterOptions>(DEFAULT_GUTTER);
  const [view, setView] = useState<ViewMode>('sheet');
  /** How far ahead the keyboard view shows, in seconds. */
  const [fallSeconds, setFallSeconds] = useState(4);
  // Larger than OSMD's default: the letter columns need the vertical room.
  const [zoom, setZoom] = useState(1.4);
  const [follow, setFollow] = useState(true);
  const [hideClefs, setHideClefs] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [rate, setRate] = useState(1);
  const [mutedStaves, setMutedStaves] = useState<number[]>([]);

  const [midiOutputs, setMidiOutputs] = useState<MidiOutputLike[]>([]);
  const [midiOutputId, setMidiOutputId] = useState('');

  const [transport, setTransport] = useState({ playing: false, position: 0, duration: 0 });

  useEffect(() => {
    player.onUpdate = setTransport;
    return () => {
      player.onUpdate = null;
    };
  }, [player]);

  useEffect(() => () => player.dispose(), [player]);

  useEffect(() => {
    void listMidiOutputs().then(setMidiOutputs);
  }, []);

  const openBuffer = useCallback(
    async (data: ArrayBuffer, filename: string) => {
      setBusy(true);
      setError(null);
      try {
        const { xml, doc, source, notice } = await loadMusicXml(data, filename);
        const score = parseScore(doc);
        player.stop();
        player.load(score.notes, score.totalDuration);
        setMutedStaves([]);
        setNotice(notice);
        setLoaded({ xml, score, filename, source });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [player],
  );

  const loadExample = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch(EXAMPLE_URL);
      if (!response.ok) throw new Error(`Could not fetch the example score (${response.status}).`);
      await openBuffer(await response.arrayBuffer(), 'example.mxl');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [openBuffer]);

  // Load the bundled example on first run so there is always something on screen.
  useEffect(() => {
    void loadExample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openFile = useCallback(
    async (file: File) => {
      await openBuffer(await file.arrayBuffer(), file.name);
    },
    [openBuffer],
  );

  const currentMeasure = useMemo(() => {
    if (!loaded) return -1;
    if (!transport.playing && transport.position <= 0) return -1;
    return measureAt(loaded.score.measureStarts, transport.position);
  }, [loaded, transport.playing, transport.position]);

  const handlePlayPause = useCallback(() => {
    if (player.state.playing) player.pause();
    else player.play();
  }, [player]);

  const handleRate = useCallback(
    (next: number) => {
      player.setRate(next);
      setRate(next);
    },
    [player],
  );

  const handleVolume = useCallback(
    (next: number) => {
      player.setVolume(next);
      setVolume(next);
    },
    [player],
  );

  const handleToggleStaff = useCallback(
    (staffIndex: number) => {
      setMutedStaves((previous) => {
        const muted = previous.includes(staffIndex);
        player.setStaffMuted(staffIndex, !muted);
        return muted ? previous.filter((i) => i !== staffIndex) : [...previous, staffIndex];
      });
    },
    [player],
  );

  const handleMidiOutput = useCallback(
    (id: string) => {
      setMidiOutputId(id);
      player.useMidiOutput(midiOutputs.find((output) => output.id === id) ?? null);
    },
    [player, midiOutputs],
  );

  // Space bar is the natural play/pause key while reading.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        handlePlayPause();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlePlayPause]);

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void openFile(file);
      }}
    >
      <Toolbar
        title={loaded?.score.title ?? ''}
        composer={loaded?.score.composer ?? ''}
        playing={transport.playing}
        position={transport.position}
        duration={transport.duration}
        onPlayPause={handlePlayPause}
        onStop={() => player.stop()}
        onSeek={(seconds) => player.seek(seconds)}
        rate={rate}
        onRate={handleRate}
        volume={volume}
        onVolume={handleVolume}
        zoom={zoom}
        onZoom={setZoom}
        gutter={gutter}
        onGutter={setGutter}
        view={view}
        onView={setView}
        fallSeconds={fallSeconds}
        onFallSeconds={setFallSeconds}
        source={loaded?.source ?? 'musicxml'}
        follow={follow}
        onFollow={setFollow}
        hideClefs={hideClefs}
        onHideClefs={setHideClefs}
        staffCount={loaded?.score.staffCount ?? 0}
        mutedStaves={mutedStaves}
        onToggleStaff={handleToggleStaff}
        midiOutputs={midiOutputs}
        midiOutputId={midiOutputId}
        onMidiOutput={handleMidiOutput}
        onOpenFile={(file) => void openFile(file)}
        onLoadExample={() => void loadExample()}
        disabled={!loaded}
      />

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {/* An import that had to guess says so, rather than passing the guess off
          as the score the reader handed us. */}
      {notice && !error && (
        <div className="banner banner-notice">
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="stage">
        {/*
          Both views stay mounted. Re-engraving a long score costs seconds, so
          the sheet is hidden rather than unmounted — and hidden by visibility,
          which keeps its width valid so it does not re-layout on the way back.
        */}
        <div className={`stage-layer${view === 'sheet' ? '' : ' stage-layer-hidden'}`}>
          <ScoreView
            xml={loaded?.xml ?? null}
            score={loaded?.score ?? null}
            gutter={gutter}
            zoom={zoom}
            currentMeasure={currentMeasure}
            follow={follow}
            hideClefs={hideClefs}
            onError={setError}
            onRenderStateChange={setBusy}
          />
        </div>
        <div className={`stage-layer${view === 'keyboard' ? '' : ' stage-layer-hidden'}`}>
          <PianoRoll
            score={loaded?.score ?? null}
            player={player}
            active={view === 'keyboard'}
            colorByLetter={gutter.colorByLetter}
            showLetters={gutter.lettersInNotes}
            fallSeconds={fallSeconds}
            mutedStaves={mutedStaves}
          />
        </div>
        {busy && view === 'sheet' && <div className="busy">Rendering…</div>}
        {dragging && (
          <div className="drop-hint">Drop a score: .musicxml, .xml, .mxl, .mid or .pdf</div>
        )}
      </main>
    </div>
  );
}
