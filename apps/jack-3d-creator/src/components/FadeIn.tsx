import { motion } from 'framer-motion';
import { useMemo, type CSSProperties, type ElementType, type ReactNode } from 'react';

type Tag = keyof JSX.IntrinsicElements;

interface FadeInProps {
  /** The element to render, e.g. 'div', 'h1', 'nav', 'p'. */
  as?: Tag;
  delay?: number;
  duration?: number;
  x?: number;
  y?: number;
  className?: string;
  style?: CSSProperties;
  id?: string;
  children?: ReactNode;
}

/** One motion component per tag, made once: a component created during render would remount on every render. */
const motionTags = new Map<Tag, ElementType>();
function motionTag(tag: Tag): ElementType {
  let component = motionTags.get(tag);
  if (!component) {
    component = motion.create(tag) as ElementType;
    motionTags.set(tag, component);
  }
  return component;
}

/** Fades and slides its content in the first time it comes into view. */
export function FadeIn({ as = 'div', delay = 0, duration = 0.7, x = 0, y = 30, children, ...rest }: FadeInProps) {
  const Component = useMemo(() => motionTag(as), [as]);
  return (
    <Component
      initial={{ opacity: 0, x, y }}
      whileInView={{ opacity: 1, x: 0, y: 0 }}
      viewport={{ once: true, margin: '50px', amount: 0 }}
      transition={{ duration, delay, ease: [0.25, 0.1, 0.25, 1] }}
      {...rest}
    >
      {children}
    </Component>
  );
}
