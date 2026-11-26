interface ContactButtonProps {
  href?: string;
}

/** The gradient "Contact Me" pill. */
export function ContactButton({ href = '#contact' }: ContactButtonProps) {
  return (
    <a
      href={href}
      // The white outline is set with classes, not inline, so that keyboard focus can still show a ring around the pill.
      className="inline-block whitespace-nowrap rounded-full px-8 py-3 text-xs font-medium uppercase tracking-widest text-white outline outline-2 outline-offset-[-3px] outline-white focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-[#D7E2EA] sm:px-10 sm:py-3.5 sm:text-sm md:px-12 md:py-4 md:text-base"
      style={{
        background: 'linear-gradient(123deg, #18011F 7%, #B600A8 37%, #7621B0 72%, #BE4C00 100%)',
        boxShadow: '0px 4px 4px rgba(181, 1, 167, 0.25), 4px 4px 12px #7721B1 inset',
      }}
    >
      Contact Me
    </a>
  );
}
