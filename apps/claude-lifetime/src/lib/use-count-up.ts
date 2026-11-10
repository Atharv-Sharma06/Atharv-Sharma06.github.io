'use client';

import { animate } from 'motion';
import { useEffect, useRef, useState } from 'react';

/**
 * Animates a figure from its previous value to the new one. Used once per page, for
 * the headline figure. People who prefer reduced motion get the value immediately.
 */
export function useCountUp(target: number, durationSeconds = 0.8): number {
  const [value, setValue] = useState(target);
  const previous = useRef(0);

  useEffect(() => {
    const from = previous.current;
    previous.current = target;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || from === target) {
      setValue(target);
      return;
    }
    const controls = animate(from, target, {
      duration: durationSeconds,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setValue(v),
      onComplete: () => setValue(target),
    });
    return () => controls.stop();
  }, [target, durationSeconds]);

  return value;
}
