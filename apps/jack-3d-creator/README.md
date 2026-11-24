# Jack — 3D Creator

A one-page portfolio for a 3D creator: React 18, TypeScript, Tailwind CSS 3, Framer Motion 12 and Lucide React, built with Vite.

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck, then a static build in dist/
npm run preview   # serve the build
```

The build uses relative paths, so `dist/` can be served from any folder.

## Sections

1. **Hero**: navigation, the gradient "Hi, i'm jack" heading, and a portrait that follows the mouse (`Magnet`).
2. **Marquee**: two rows of previews that slide in opposite directions as the page scrolls.
3. **About**: four 3D images in the corners, and a paragraph revealed character by character on scroll (`AnimatedText`).
4. **Services**: five numbered services on a white panel.
5. **Projects**: three cards that stick and stack as the page scrolls, each shrinking slightly as the next one covers it.

## Where things are

- `src/data.ts`: every image URL, the services and the projects.
- `src/components/`: `FadeIn`, `Magnet`, `AnimatedText`, `ContactButton`, `LiveProjectButton`.
- `src/sections/`: one file per section.

## To fill in

- The About section's "Contact Me" button opens `mailto:hello@example.com`; put the real address in `src/sections/AboutSection.tsx`. The hero's button and the "Contact" link scroll to it.
- The "Live Project" buttons link to `#`; give each project its link.
