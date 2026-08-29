import type { LibraryEntry } from '../native/library';

export interface LibraryProps {
  entries: LibraryEntry[];
  /** File name of the score on screen, so it can be marked. */
  currentName: string | null;
  onOpen: (name: string) => void;
  onDelete: (name: string) => void;
  onPickFile: () => void;
  onLoadExample: () => void;
  onClose: () => void;
}

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const formatDate = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** The extension is the only honest label for what a score was read from. */
const kindOf = (name: string): string => {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (extension === 'mid' || extension === 'midi') return 'MIDI';
  if (extension === 'pdf') return 'PDF';
  if (extension === 'mxl') return 'MXL';
  return 'MusicXML';
};

/**
 * The score library, on device.
 *
 * This is the iPad's answer to dragging a file onto a window: there is nowhere
 * to drag from, so scores live in the app and are picked from a list. It is
 * backed by a plain folder in Documents, which the Files app can also see.
 */
export function Library(props: LibraryProps) {
  return (
    <div className="library-backdrop" onClick={props.onClose}>
      <div
        className="library"
        role="dialog"
        aria-label="Score library"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="library-head">
          <h2>Library</h2>
          <button type="button" onClick={props.onClose} aria-label="Close library">
            ×
          </button>
        </header>

        <div className="library-actions">
          <button type="button" onClick={props.onPickFile}>
            Add a score…
          </button>
          <button type="button" onClick={props.onLoadExample}>
            Example
          </button>
        </div>

        {props.entries.length === 0 ? (
          <p className="library-empty">
            Nothing here yet. Add a <code>.musicxml</code>, <code>.mxl</code>, <code>.mid</code> or{' '}
            <code>.pdf</code> — or send one to Sheet Reader from Files, Mail or AirDrop. Everything
            stays on this iPad.
          </p>
        ) : (
          <ul className="library-list">
            {props.entries.map((entry) => (
              <li key={entry.name} className={entry.name === props.currentName ? 'current' : ''}>
                <button
                  type="button"
                  className="library-open"
                  onClick={() => props.onOpen(entry.name)}
                >
                  <span className="library-title">{entry.title || entry.name}</span>
                  <span className="library-sub">
                    {[entry.composer, kindOf(entry.name), formatSize(entry.size), formatDate(entry.modified)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
                <button
                  type="button"
                  className="library-delete"
                  onClick={() => props.onDelete(entry.name)}
                  aria-label={`Remove ${entry.title || entry.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
