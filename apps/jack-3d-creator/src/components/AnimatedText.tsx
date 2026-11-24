import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion';
import { useRef, type CSSProperties } from 'react';

interface AnimatedTextProps {
  text: string;
  className?: string;
  style?: CSSProperties;
}

/** Reveals the text character by character as the paragraph scrolls through the viewport. */
export function AnimatedText({ text, className, style }: AnimatedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.8', 'end 0.2'] });
  const characters = text.split('');

  return (
    <p ref={ref} className={className} style={style}>
      {/* Read once as a whole by screen readers; the characters below are only for the eye. */}
      <span className="sr-only">{text}</span>
      {characters.map((character, i) => {
        const start = i / characters.length;
        return (
          <Character key={i} progress={scrollYProgress} range={[start, start + 1 / characters.length]}>
            {character}
          </Character>
        );
      })}
    </p>
  );
}

function Character({ children, progress, range }: { children: string; progress: MotionValue<number>; range: [number, number] }) {
  const opacity = useTransform(progress, range, [0.2, 1]);
  return (
    <span className="relative" aria-hidden="true">
      {/* The invisible copy keeps the layout; the animated one sits on top of it. */}
      <span className="opacity-0">{children}</span>
      <motion.span className="absolute left-0 top-0" style={{ opacity }}>
        {children}
      </motion.span>
    </span>
  );
}
