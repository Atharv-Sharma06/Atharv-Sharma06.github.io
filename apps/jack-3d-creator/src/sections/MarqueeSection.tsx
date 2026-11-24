import { useEffect, useRef, type RefObject } from 'react';
import { MARQUEE_IMAGES } from '../data';

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ROW_1 = MARQUEE_IMAGES.slice(0, 11);
const ROW_2 = MARQUEE_IMAGES.slice(11);
/** Each row is repeated three times, so there is always more of it on either side while it moves. */
const triple = (images: string[]) => [...images, ...images, ...images];

/** Two rows of previews that slide in opposite directions as the page scrolls. */
export function MarqueeSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const row1Ref = useRef<HTMLDivElement>(null);
  const row2Ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const section = sectionRef.current;
      if (!section) return;
      const sectionTop = section.getBoundingClientRect().top + window.scrollY;
      // With reduced motion asked for, the rows stay where they start.
      const offset = prefersReducedMotion() ? 0 : (window.scrollY - sectionTop + window.innerHeight) * 0.3;
      // Written straight to the elements: re-rendering 63 images on every scroll event would be wasted work.
      if (row1Ref.current) row1Ref.current.style.transform = `translateX(${offset - 200}px)`;
      if (row2Ref.current) row2Ref.current.style.transform = `translateX(${-(offset - 200)}px)`;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section ref={sectionRef} className="flex flex-col gap-3 pb-10 pt-24 sm:pt-32 md:pt-40" style={{ background: '#0C0C0C' }}>
      <MarqueeRow rowRef={row1Ref} images={triple(ROW_1)} />
      <MarqueeRow rowRef={row2Ref} images={triple(ROW_2)} />
    </section>
  );
}

function MarqueeRow({ rowRef, images }: { rowRef: RefObject<HTMLDivElement>; images: string[] }) {
  return (
    // Centred, so the long row reaches past both edges of the screen.
    <div className="flex justify-center">
      <div ref={rowRef} className="flex w-max shrink-0 gap-3" style={{ willChange: 'transform' }}>
        {images.map((src, i) => (
          <img key={i} src={src} alt="" loading="lazy" className="h-[270px] w-[420px] shrink-0 rounded-2xl object-cover" />
        ))}
      </div>
    </div>
  );
}
