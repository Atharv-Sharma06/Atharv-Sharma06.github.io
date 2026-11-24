import { useEffect, useRef, useState, type ReactNode } from 'react';

interface MagnetProps {
  children: ReactNode;
  /** How far outside the element's edge (in px) the cursor still pulls it. */
  padding?: number;
  /** The offset is the cursor's distance from the centre divided by this: higher is subtler. */
  strength?: number;
  activeTransition?: string;
  inactiveTransition?: string;
  disabled?: boolean;
  className?: string;
  innerClassName?: string;
}

/** Moves its content towards the mouse while the cursor is within `padding` of the element. */
export function Magnet({
  children,
  padding = 100,
  strength = 2,
  activeTransition = 'transform 0.3s ease-out',
  inactiveTransition = 'transform 0.5s ease-in-out',
  disabled = false,
  className = '',
  innerClassName = '',
}: MagnetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    // Also still with reduced motion asked for in the system settings.
    if (disabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setActive(false);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const onMove = (event: MouseEvent) => {
      const element = ref.current;
      if (!element) return;
      const { left, top, width, height } = element.getBoundingClientRect();
      const centerX = left + width / 2;
      const centerY = top + height / 2;
      const near = Math.abs(event.clientX - centerX) < width / 2 + padding && Math.abs(event.clientY - centerY) < height / 2 + padding;
      if (near) {
        setActive(true);
        setOffset({ x: (event.clientX - centerX) / strength, y: (event.clientY - centerY) / strength });
      } else {
        setActive(false);
        setOffset({ x: 0, y: 0 });
      }
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [padding, strength, disabled]);

  return (
    <div ref={ref} className={className}>
      <div
        className={innerClassName}
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
          transition: active ? activeTransition : inactiveTransition,
          willChange: 'transform',
        }}
      >
        {children}
      </div>
    </div>
  );
}
