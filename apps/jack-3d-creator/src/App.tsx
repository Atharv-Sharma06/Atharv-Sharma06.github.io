import { MotionConfig } from 'framer-motion';
import { AboutSection } from './sections/AboutSection';
import { HeroSection } from './sections/HeroSection';
import { MarqueeSection } from './sections/MarqueeSection';
import { ProjectsSection } from './sections/ProjectsSection';
import { ServicesSection } from './sections/ServicesSection';

export default function App() {
  return (
    // With reduced motion asked for in the system settings, the fade-ins appear without sliding.
    <MotionConfig reducedMotion="user">
      <main style={{ background: '#0C0C0C', overflowX: 'clip' }}>
        <HeroSection />
        <MarqueeSection />
        <AboutSection />
        <ServicesSection />
        <ProjectsSection />
      </main>
    </MotionConfig>
  );
}
