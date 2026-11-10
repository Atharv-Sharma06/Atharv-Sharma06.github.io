import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "Leave out of totals" dialog is rendered only while it is open, so it is removed
 * rather than closed and cannot hand focus back itself; its focus trap then leaves focus
 * on the page body. useFocusReturn gives focus back to the control that opened it, after
 * the trap's own timer has run.
 *
 * React's hooks are replaced by stand-ins that run an effect at once and keep one ref, so
 * the hook can be driven render by render without a DOM.
 */
const hooks = vi.hoisted(() => ({ ref: { current: null as unknown }, cleanups: [] as Array<() => void> }));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useRef: () => hooks.ref,
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (cleanup) hooks.cleanups.push(cleanup);
    },
  };
});

class FakeElement {
  isConnected = true;
  focus = vi.fn();
}

let active: FakeElement | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  hooks.ref.current = null;
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('document', {
    get activeElement() {
      return active;
    },
  });
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('focus after a dialog that is only rendered while open', () => {
  it('returns to the switch that opened it, once the dialog is gone', async () => {
    const { useFocusReturn } = await import('@/features/settings/parts');
    const toggle = new FakeElement();
    const input = new FakeElement();

    active = toggle;
    const remember = useFocusReturn(false);
    remember();
    // The dialog opens and focus moves into it.
    useFocusReturn(true);
    active = input;
    // Saved or cancelled: the dialog is removed and its focus trap sends focus to the body.
    useFocusReturn(false);
    active = null;
    expect(toggle.focus).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(toggle.focus).toHaveBeenCalledTimes(1);
    expect(input.focus).not.toHaveBeenCalled();

    // Later renders with the dialog closed do not move focus again.
    useFocusReturn(false);
    vi.runAllTimers();
    expect(toggle.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves focus alone when the opener is no longer on the page, or when nothing was remembered', async () => {
    const { useFocusReturn } = await import('@/features/settings/parts');
    const link = new FakeElement();
    active = link;
    useFocusReturn(false)();
    useFocusReturn(true);
    link.isConnected = false;
    useFocusReturn(false);
    vi.runAllTimers();
    expect(link.focus).not.toHaveBeenCalled();

    const other = new FakeElement();
    active = other;
    useFocusReturn(true);
    useFocusReturn(false);
    vi.runAllTimers();
    expect(other.focus).not.toHaveBeenCalled();
  });
});
