import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { ParsedScore } from '../score/types';
import { drawLetterGutter, gutterReserveUnits, type GutterOptions } from '../render/letterGutter';
import { MeasureHighlighter } from '../render/highlight';
import { drawNoteLetters } from '../render/noteLetters';

export interface ScoreViewProps {
  xml: string | null;
  score: ParsedScore | null;
  gutter: GutterOptions;
  zoom: number;
  /** Commits a pinch-to-resize, which is the touch equivalent of the Size slider. */
  onZoom: (zoom: number) => void;
  currentMeasure: number;
  follow: boolean;
  hideClefs: boolean;
  onError: (message: string) => void;
  onRenderStateChange: (rendering: boolean) => void;
}

/** OSMD's default page margin, in units. We add the gutter on top of it. */
const BASE_PAGE_LEFT_MARGIN = 5;

/** The Size slider's range, which pinch has to stay inside. */
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 3;

/**
 * WebKit's pinch events, which is what an iPad reports a two-finger zoom as.
 * They are not in the DOM lib because no other engine has them; on anything
 * else these listeners simply never fire.
 */
interface GestureEventLike extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

export function ScoreView({
  xml,
  score,
  gutter,
  zoom,
  onZoom,
  currentMeasure,
  follow,
  hideClefs,
  onError,
  onRenderStateChange,
}: ScoreViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const highlighterRef = useRef<MeasureHighlighter | null>(null);
  /** Guards against overlapping async loads (React strict mode, fast file switches). */
  const runRef = useRef(0);

  const [loadedXml, setLoadedXml] = useState<string | null>(null);
  const [renderNonce, setRenderNonce] = useState(0);

  // Keep the latest callbacks without making the render effects depend on them.
  const onErrorRef = useRef(onError);
  const onRenderStateChangeRef = useRef(onRenderStateChange);
  onErrorRef.current = onError;
  onRenderStateChangeRef.current = onRenderStateChange;

  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const osmd = new OpenSheetMusicDisplay(hostRef.current, {
      backend: 'svg',
      autoResize: false,
      drawTitle: true,
      drawSubtitle: true,
      drawComposer: true,
      drawPartNames: false,
      followCursor: false,
    });
    osmdRef.current = osmd;
    highlighterRef.current = new MeasureHighlighter(osmd);
    // Debug hook: lets the verify/probe scripts drive OSMD directly.
    (window as any).__osmd = osmd;

    return () => {
      highlighterRef.current = null;
      osmdRef.current = null;
      try {
        osmd.clear();
      } catch {
        // Nothing rendered yet.
      }
    };
  }, []);

  // Load a new score.
  useEffect(() => {
    const osmd = osmdRef.current;
    if (!osmd || !xml) return;

    const run = ++runRef.current;
    let cancelled = false;
    onRenderStateChangeRef.current(true);

    osmd
      .load(xml)
      .then(() => {
        if (cancelled || run !== runRef.current) return;
        setLoadedXml(xml);
        setRenderNonce((n) => n + 1);
      })
      .catch((error: unknown) => {
        if (cancelled || run !== runRef.current) return;
        onRenderStateChangeRef.current(false);
        onErrorRef.current(
          `Could not render this score: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [xml]);

  // Re-render whenever layout-affecting settings change.
  useEffect(() => {
    const osmd = osmdRef.current;
    if (!osmd || !score || loadedXml === null || loadedXml !== xml) return;

    onRenderStateChangeRef.current(true);
    try {
      // Reserve horizontal room for the letter column before laying out. In
      // per-measure mode every measure needs its own space, so the room comes
      // from the measure margin rather than the page margin.
      const gutterWidth = gutterReserveUnits(gutter);
      const perMeasure = gutter.mode === 'measure';
      osmd.EngravingRules.MeasureLeftMargin = perMeasure ? gutterWidth : 0;
      osmd.EngravingRules.PageLeftMargin =
        BASE_PAGE_LEFT_MARGIN + (perMeasure ? 0 : gutterWidth);
      // The letter guide names every position, so the clef is optional; hiding
      // it buys back room at the start of each line.
      osmd.EngravingRules.RenderClefsAtBeginningOfStaffline = !hideClefs;
      osmd.zoom = zoom;
      osmd.render();
      drawLetterGutter(osmd, score, gutter);
      drawNoteLetters(osmd, score, {
        enabled: gutter.lettersInNotes,
        colorByLetter: gutter.colorByLetter,
      });
      highlighterRef.current?.refresh();
      // Debug hook for the verify script.
      (window as any).__score = score;
    } catch (error) {
      onErrorRef.current(
        `Could not render this score: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      onRenderStateChangeRef.current(false);
    }
  }, [loadedXml, xml, score, gutter, zoom, hideClefs, renderNonce]);

  // Re-render on container width changes, debounced.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !loadedXml) return;

    let lastWidth = scroller.clientWidth;
    let timer: number | null = null;

    const observer = new ResizeObserver(() => {
      const width = scroller.clientWidth;
      if (Math.abs(width - lastWidth) < 8) return;
      lastWidth = width;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setRenderNonce((n) => n + 1), 180);
    });
    observer.observe(scroller);

    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadedXml]);

  // Follow playback.
  useEffect(() => {
    const highlighter = highlighterRef.current;
    if (!highlighter) return;
    if (currentMeasure < 0) {
      highlighter.clear();
      return;
    }

    const rect = highlighter.show(currentMeasure);
    if (!rect || !follow || !scrollRef.current) return;

    const scroller = scrollRef.current;
    const bounds = rect.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const above = bounds.top < view.top + view.height * 0.15;
    const below = bounds.bottom > view.bottom - view.height * 0.15;
    if (!above && !below) return;

    scroller.scrollTo({
      top: scroller.scrollTop + (bounds.top - view.top) - view.height * 0.3,
      behavior: 'smooth',
    });
  }, [currentMeasure, follow, renderNonce]);

  /*
   * Pinch to resize.
   *
   * Re-engraving costs seconds on a long score, so a pinch cannot re-render as
   * it moves any more than the Size slider can — same reason, same answer: the
   * gesture scales the drawn SVG with a CSS transform for feedback and commits
   * the real size once on release. The transform's origin is the point between
   * the fingers, so the bar being read stays under them.
   */
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const scroller = scrollRef.current;
    const host = hostRef.current;
    if (!scroller || !host) return;

    let base = 0;

    const onStart = (event: Event) => {
      const gesture = event as GestureEventLike;
      event.preventDefault();
      base = zoomRef.current;
      const box = host.getBoundingClientRect();
      host.style.transformOrigin = `${gesture.clientX - box.left}px ${gesture.clientY - box.top}px`;
    };

    const onChange = (event: Event) => {
      const gesture = event as GestureEventLike;
      event.preventDefault();
      if (!base) return;
      const wanted = clampZoom(base * gesture.scale);
      host.style.transform = `scale(${wanted / base})`;
    };

    const onEnd = (event: Event) => {
      const gesture = event as GestureEventLike;
      event.preventDefault();
      if (!base) return;
      const wanted = clampZoom(base * gesture.scale);
      host.style.transform = '';
      host.style.transformOrigin = '';
      base = 0;
      // A pinch that barely moved is a two-finger scroll, not a resize.
      if (Math.abs(wanted - zoomRef.current) >= 0.05) onZoom(snapZoom(wanted));
    };

    scroller.addEventListener('gesturestart', onStart);
    scroller.addEventListener('gesturechange', onChange);
    scroller.addEventListener('gestureend', onEnd);
    return () => {
      scroller.removeEventListener('gesturestart', onStart);
      scroller.removeEventListener('gesturechange', onChange);
      scroller.removeEventListener('gestureend', onEnd);
    };
  }, [onZoom]);

  return (
    <div className="score-scroll" ref={scrollRef}>
      <div className="score-host" ref={hostRef} />
    </div>
  );
}

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** A pinch should land on a size the slider can also reach, not between two. */
const snapZoom = (zoom: number): number => Math.round(zoom * 20) / 20;
