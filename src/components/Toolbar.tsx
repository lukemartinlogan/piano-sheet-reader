import { useEffect, useRef, useState } from 'react';
import type { GutterMode, GutterOptions } from '../render/letterGutter';
import type { MidiOutputLike } from '../audio/PianoSynth';

/** Sheet music, or notes falling onto a keyboard. */
export type ViewMode = 'sheet' | 'keyboard';

export interface ToolbarProps {
  title: string;
  composer: string;
  /** What the notation was read from, when it was not MusicXML to begin with. */
  source: 'musicxml' | 'midi' | 'pdf';
  playing: boolean;
  position: number;
  duration: number;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  rate: number;
  onRate: (rate: number) => void;
  volume: number;
  onVolume: (volume: number) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  gutter: GutterOptions;
  onGutter: (gutter: GutterOptions) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  fallSeconds: number;
  onFallSeconds: (seconds: number) => void;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  hideClefs: boolean;
  onHideClefs: (hide: boolean) => void;
  staffCount: number;
  mutedStaves: number[];
  onToggleStaff: (staffIndex: number) => void;
  midiOutputs: MidiOutputLike[];
  midiOutputId: string;
  onMidiOutput: (id: string) => void;
  onOpenFile: (file: File) => void;
  onLoadExample: () => void;
  disabled: boolean;
}

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Solo piano is the common case, so name the staves rather than numbering them. */
const staffLabel = (index: number, count: number): string => {
  if (count === 2) return index === 0 ? 'Right hand' : 'Left hand';
  return `Staff ${index + 1}`;
};

export function Toolbar(props: ToolbarProps) {
  const [showSettings, setShowSettings] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Size is applied on release, not while dragging.
   *
   * Every change re-engraves the whole score, which for a long piece takes long
   * enough that committing on each drag event queues dozens of full re-renders
   * and locks up the page. The draft keeps the slider and its readout live so
   * the control still feels responsive.
   */
  const [zoomDraft, setZoomDraft] = useState(props.zoom);
  useEffect(() => setZoomDraft(props.zoom), [props.zoom]);
  const commitZoom = () => {
    if (zoomDraft !== props.zoom) props.onZoom(zoomDraft);
  };

  const setGutter = (patch: Partial<GutterOptions>) => props.onGutter({ ...props.gutter, ...patch });

  return (
    <header className="toolbar">
      <div className="toolbar-row toolbar-row-main">
        <div className="score-meta">
          <span className="score-title">{props.title || 'No score loaded'}</span>
          {props.composer && <span className="score-composer">{props.composer}</span>}
          {props.source !== 'musicxml' && (
            <span
              className="score-source"
              title={`Transcribed from a ${props.source === 'pdf' ? 'PDF' : 'MIDI file'}`}
            >
              from {props.source === 'pdf' ? 'PDF' : 'MIDI'}
            </span>
          )}
        </div>

        <div className="toolbar-actions">
          {/* The two views are alternatives, so they read as one control. */}
          <div className="view-switch" role="group" aria-label="View">
            <button
              type="button"
              className={props.view === 'sheet' ? 'active' : ''}
              aria-pressed={props.view === 'sheet'}
              onClick={() => props.onView('sheet')}
            >
              Sheet
            </button>
            <button
              type="button"
              className={props.view === 'keyboard' ? 'active' : ''}
              aria-pressed={props.view === 'keyboard'}
              onClick={() => props.onView('keyboard')}
            >
              Keyboard
            </button>
          </div>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            Open file
          </button>
          <button type="button" onClick={props.onLoadExample}>
            Example
          </button>
          <button
            type="button"
            className={showSettings ? 'active' : ''}
            aria-expanded={showSettings}
            onClick={() => setShowSettings((v) => !v)}
          >
            Settings
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xml,.musicxml,.mxl,.mid,.midi,.pdf"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onOpenFile(file);
              event.target.value = '';
            }}
          />
        </div>
      </div>

      <div className="toolbar-row toolbar-transport">
        <button
          type="button"
          className="transport-play"
          onClick={props.onPlayPause}
          disabled={props.disabled}
          aria-label={props.playing ? 'Pause' : 'Play'}
        >
          {props.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          onClick={props.onStop}
          disabled={props.disabled}
          aria-label="Stop and return to the beginning"
        >
          ■
        </button>

        <span className="time">{formatTime(props.position)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(0.1, props.duration)}
          step={0.05}
          value={Math.min(props.position, props.duration)}
          disabled={props.disabled}
          onChange={(event) => props.onSeek(parseFloat(event.target.value))}
          aria-label="Seek"
        />
        <span className="time time-total">{formatTime(props.duration)}</span>

        <label className="inline-field">
          Tempo
          <input
            type="range"
            min={0.25}
            max={1.5}
            step={0.05}
            value={props.rate}
            onChange={(event) => props.onRate(parseFloat(event.target.value))}
          />
          <span className="readout">{Math.round(props.rate * 100)}%</span>
        </label>
      </div>

      {showSettings && (
        <div className="settings">
          <fieldset>
            <legend>Letter guide</legend>
            <label className="inline-field">
              Show at
              <select
                value={props.gutter.mode}
                onChange={(event) => setGutter({ mode: event.target.value as GutterMode })}
              >
                <option value="measure">Every barline</option>
                <option value="system">Start of each line</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={props.gutter.showOctaves}
                onChange={(event) => setGutter({ showOctaves: event.target.checked })}
              />
              Octave numbers
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={props.gutter.lettersInNotes}
                onChange={(event) => setGutter({ lettersInNotes: event.target.checked })}
              />
              Letters inside noteheads
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={props.gutter.colorByLetter}
                onChange={(event) => setGutter({ colorByLetter: event.target.checked })}
              />
              Color-code letters
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={props.gutter.showBands}
                onChange={(event) => setGutter({ showBands: event.target.checked })}
              />
              Row highlighting
            </label>
            <label className="inline-field">
              Extra rows
              <input
                type="number"
                min={0}
                max={3}
                value={props.gutter.ledgerPositions}
                onChange={(event) =>
                  setGutter({
                    ledgerPositions: Math.max(0, Math.min(3, parseInt(event.target.value, 10) || 0)),
                  })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Display</legend>
            <label className="inline-field">
              Size
              <input
                type="range"
                min={0.6}
                max={3}
                step={0.1}
                value={zoomDraft}
                onChange={(event) => setZoomDraft(parseFloat(event.target.value))}
                onPointerUp={commitZoom}
                onKeyUp={commitZoom}
                onBlur={commitZoom}
              />
              <span className="readout">{Math.round(zoomDraft * 100)}%</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={props.follow}
                onChange={(event) => props.onFollow(event.target.checked)}
              />
              Scroll to follow playback
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={props.hideClefs}
                onChange={(event) => props.onHideClefs(event.target.checked)}
              />
              Hide clefs
            </label>
          </fieldset>

          <fieldset>
            <legend>Keyboard view</legend>
            {/* Colour coding and letters are shared with the sheet, so a colour
                still means the same note in both views. */}
            <label className="inline-field">
              Look ahead
              <input
                type="range"
                min={1.5}
                max={10}
                step={0.5}
                value={props.fallSeconds}
                onChange={(event) => props.onFallSeconds(parseFloat(event.target.value))}
              />
              <span className="readout">{props.fallSeconds.toFixed(1)}s</span>
            </label>
            <p className="hint">Scroll the roll to scrub; tap a key to hear it.</p>
          </fieldset>

          <fieldset>
            <legend>Sound</legend>
            <label className="inline-field">
              Volume
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={props.volume}
                onChange={(event) => props.onVolume(parseFloat(event.target.value))}
              />
            </label>
            {Array.from({ length: props.staffCount }, (_, index) => (
              <label className="checkbox" key={index}>
                <input
                  type="checkbox"
                  checked={!props.mutedStaves.includes(index)}
                  onChange={() => props.onToggleStaff(index)}
                />
                {staffLabel(index, props.staffCount)}
              </label>
            ))}
            <label className="inline-field">
              Output
              <select
                value={props.midiOutputId}
                onChange={(event) => props.onMidiOutput(event.target.value)}
              >
                <option value="">Built-in piano</option>
                {props.midiOutputs.map((output) => (
                  <option key={output.id} value={output.id}>
                    {output.name || output.id}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        </div>
      )}
    </header>
  );
}
