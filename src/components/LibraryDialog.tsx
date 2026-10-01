import { useCallback, useEffect, useState } from 'react';
import { deleteFromLibrary, fileFromLibrary, listLibrary, type LibraryEntry } from '../library';

export interface LibraryDialogProps {
  onClose: () => void;
  /** Hand a stored sheet to the app's normal open path. */
  onOpen: (file: File) => void;
}

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** nginx emits RFC 1123; show something shorter and local. */
const formatDate = (mtime: string): string => {
  const at = new Date(mtime);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

/**
 * The "Choose Existing" picker: the sheets held on the server, shared by every
 * tab and device pointed at it.
 */
export function LibraryDialog({ onClose, onOpen }: LibraryDialogProps) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setEntries(await listLibrary());
    } catch (cause) {
      setEntries([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Escape closes, matching the settings panel.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleOpen = useCallback(
    async (name: string) => {
      setPending(name);
      setError(null);
      try {
        onOpen(await fileFromLibrary(name));
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(null);
      }
    },
    [onClose, onOpen],
  );

  const handleDelete = useCallback(
    async (name: string) => {
      setPending(name);
      setError(null);
      try {
        await deleteFromLibrary(name);
        setConfirming(null);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(null);
      }
    },
    [refresh],
  );

  return (
    <div className="library-backdrop" onClick={onClose} role="presentation">
      <div
        className="library-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Sheets on the server"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="library-header">
          <h2>Sheets on the server</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <p className="library-error">{error}</p>}

        {entries === null && <p className="library-empty">Loading…</p>}

        {entries !== null && entries.length === 0 && !error && (
          <p className="library-empty">
            Nothing here yet. Open a sheet with the Open file button and it will be
            uploaded here automatically.
          </p>
        )}

        {entries !== null && entries.length > 0 && (
          <ul className="library-list">
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className="library-open"
                  disabled={pending !== null}
                  onClick={() => void handleOpen(entry.name)}
                >
                  <span className="library-name">{entry.name}</span>
                  <span className="library-meta">
                    {formatSize(entry.size)}
                    {formatDate(entry.mtime) && ` · ${formatDate(entry.mtime)}`}
                  </span>
                </button>
                {confirming === entry.name ? (
                  <span className="library-confirm">
                    <button
                      type="button"
                      className="library-delete"
                      disabled={pending !== null}
                      onClick={() => void handleDelete(entry.name)}
                    >
                      {pending === entry.name ? 'Deleting…' : 'Confirm'}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="library-delete"
                    disabled={pending !== null}
                    aria-label={`Delete ${entry.name}`}
                    onClick={() => setConfirming(entry.name)}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="library-footer">
          <button type="button" onClick={() => void refresh()} disabled={pending !== null}>
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
