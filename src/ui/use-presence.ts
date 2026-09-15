import { useEffect, useRef, useState } from 'react';

export type PresenceState = 'starting' | 'entered' | 'ending';

const MOTION_NORMAL_FALLBACK_MS = 180;

const readMotionDuration = (): number => {
  if (typeof document === 'undefined') return MOTION_NORMAL_FALLBACK_MS;
  const rootStyle = typeof getComputedStyle !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const configured = Number.parseFloat(rootStyle?.getPropertyValue('--motion-normal') ?? '');
  return Number.isFinite(configured) ? configured : MOTION_NORMAL_FALLBACK_MS;
};

export function usePresence(open: boolean): { mounted: boolean; state: PresenceState } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<PresenceState>(open ? 'entered' : 'ending');
  const openRef = useRef(open);

  useEffect(() => {
    if (open === openRef.current) return undefined;
    openRef.current = open;

    if (open) {
      setMounted(true);
      setState('starting');
      const frame = window.requestAnimationFrame(() => setState('entered'));
      return () => window.cancelAnimationFrame(frame);
    }

    setState('ending');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = reducedMotion ? 0 : readMotionDuration();
    const timer = window.setTimeout(() => {
      setMounted(false);
      setState('ending');
    }, duration);
    return () => window.clearTimeout(timer);
  }, [open]);

  return { mounted, state };
}
