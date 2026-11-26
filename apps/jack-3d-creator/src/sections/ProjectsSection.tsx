import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion';
import { useRef } from 'react';
import { FadeIn } from '../components/FadeIn';
import { LiveProjectButton } from '../components/LiveProjectButton';
import { PROJECTS, type Project } from '../data';

const IMAGE_RADIUS = 'rounded-[40px] sm:rounded-[50px] md:rounded-[60px]';

export function ProjectsSection() {
  const stackRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: stackRef, offset: ['start start', 'end end'] });

  return (
    <section
      id="projects"
      className="relative z-10 -mt-10 rounded-t-[40px] px-5 pb-20 pt-20 sm:-mt-12 sm:rounded-t-[50px] sm:px-8 sm:pt-24 md:-mt-14 md:rounded-t-[60px] md:px-10 md:pt-32"
      style={{ background: '#0C0C0C' }}
    >
      <FadeIn
        as="h2"
        y={40}
        className="hero-heading mb-16 text-center font-black uppercase leading-none tracking-tight sm:mb-20 md:mb-28"
        style={{ fontSize: 'clamp(3rem, 12vw, 160px)' }}
      >
        Project
      </FadeIn>

      {/* Room below the stack for the last card's offset, so that it ends inside the section. */}
      <div ref={stackRef} className="mx-auto max-w-6xl" style={{ paddingBottom: `${(PROJECTS.length - 1) * 28}px` }}>
        {PROJECTS.map((project, index) => (
          <ProjectCard
            key={project.number}
            project={project}
            index={index}
            progress={scrollYProgress}
            range={[index / PROJECTS.length, 1]}
            targetScale={1 - (PROJECTS.length - 1 - index) * 0.03}
          />
        ))}
      </div>
    </section>
  );
}

interface ProjectCardProps {
  project: Project;
  index: number;
  progress: MotionValue<number>;
  range: [number, number];
  targetScale: number;
}

/** A card that sticks under the top of the screen and shrinks a little as the next one slides over it. */
function ProjectCard({ project, index, progress, range, targetScale }: ProjectCardProps) {
  const scale = useTransform(progress, range, [1, targetScale]);

  return (
    <div className="sticky top-24 h-[85vh] md:top-32">
      <motion.article
        className="relative origin-top rounded-[40px] border-2 border-[#D7E2EA] p-4 sm:rounded-[50px] sm:p-6 md:rounded-[60px] md:p-8"
        style={{ scale, top: `${index * 28}px`, background: '#0C0C0C' }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4 px-2 sm:px-4">
          <div className="flex items-end gap-4 sm:gap-6">
            <span className="hero-heading font-black leading-none" style={{ fontSize: 'clamp(3rem, 10vw, 140px)' }}>
              {project.number}
            </span>
            <div className="flex flex-col gap-1 pb-1 sm:pb-2 md:pb-3">
              <span className="text-xs font-light uppercase tracking-widest text-[#D7E2EA] opacity-60 sm:text-sm">{project.category}</span>
              <h3 className="font-medium uppercase text-[#D7E2EA]" style={{ fontSize: 'clamp(1rem, 2.2vw, 2.1rem)' }}>
                {project.name}
              </h3>
            </div>
          </div>
          <div className="pb-1 sm:pb-2 md:pb-3">
            <LiveProjectButton />
          </div>
        </div>

        <div className="mt-4 flex gap-3 sm:mt-6 sm:gap-4 md:mt-8">
          <div className="flex w-[40%] flex-col gap-3 sm:gap-4">
            {/* The brief's heights, capped by the screen's height as well, so that a pinned card fits on a laptop screen. */}
            <img
              src={project.column1[0]}
              alt={`${project.name}, view 1`}
              loading="lazy"
              className={`w-full object-cover ${IMAGE_RADIUS}`}
              style={{ height: 'min(clamp(130px, 16vw, 230px), 20vh)', minHeight: '130px' }}
            />
            <img
              src={project.column1[1]}
              alt={`${project.name}, view 2`}
              loading="lazy"
              className={`w-full object-cover ${IMAGE_RADIUS}`}
              style={{ height: 'min(clamp(160px, 22vw, 340px), 30vh)', minHeight: '160px' }}
            />
          </div>
          {/* The tall image fills the height the left column sets; its own proportions do not stretch the card. */}
          <div className="relative w-[60%]">
            <img
              src={project.column2}
              alt={`${project.name}, view 3`}
              loading="lazy"
              className={`absolute inset-0 h-full w-full object-cover ${IMAGE_RADIUS}`}
            />
          </div>
        </div>
      </motion.article>
    </div>
  );
}
