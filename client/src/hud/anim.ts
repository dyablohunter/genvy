/** Web Animations API helpers for HUD choreography. */

/**
 * One entrance for everything: a quick fade up from a small offset.
 *
 * The `from` edge is accepted for call-site compatibility but ignored — every
 * element enters the same way, which reads calmer than panels flying in from
 * four directions. Uses the individual `translate` property rather than
 * `transform`, so it COMPOSES with an element's own centering transform
 * (`translate(-50%, -50%)`) instead of overwriting it mid-flight.
 */
const ENTER_OFFSET = '0 14px';
/**
 * Every dock/panel deliberately shares the same subtle fade-up, whatever
 * direction its caller names — EXCEPT 'top', which really enters from above
 * (the inventory drawer hangs from the top bar and slides down out of it).
 */
const offsetFor = (dir?: 'left' | 'right' | 'bottom' | 'top') =>
  dir === 'top' ? '0 -24px' : ENTER_OFFSET;

/**
 * A translate extends its scrolling ancestor's SCROLLABLE OVERFLOW area (it
 * does not affect layout, but it does affect scroll extent), so a panel
 * entering from 14px below makes its dock briefly scrollable and flashes a
 * scrollbar. Clip the dock while any of its children are in flight, counting
 * overlapping animations so the last one to finish restores scrolling.
 */
const clipDepth = new WeakMap<HTMLElement, number>();

function whileAnimating(el: HTMLElement, finished: Promise<unknown>): Promise<unknown> {
  const dock = el.closest('.g-dock') as HTMLElement | null;
  if (!dock) return finished;
  clipDepth.set(dock, (clipDepth.get(dock) ?? 0) + 1);
  dock.classList.add('g-clip');
  const release = () => {
    const left = (clipDepth.get(dock) ?? 1) - 1;
    clipDepth.set(dock, left);
    if (left <= 0) dock.classList.remove('g-clip');
  };
  return finished.then(release, release);
}

export function slideIn(el: HTMLElement, from?: 'left' | 'right' | 'bottom' | 'top', delay = 0) {
  return whileAnimating(
    el,
    el.animate(
      [
        { opacity: 0, translate: offsetFor(from) },
        { opacity: 1, translate: '0 0' },
      ],
      { duration: 190, delay, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)', fill: 'backwards' },
    ).finished,
  );
}

export function slideOut(el: HTMLElement, to?: 'left' | 'right' | 'bottom' | 'top', delay = 0) {
  return whileAnimating(
    el,
    el.animate(
      [
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: offsetFor(to) },
      ],
      { duration: 140, delay, easing: 'ease-in', fill: 'forwards' },
    ).finished,
  );
}

export function flicker(el: HTMLElement) {
  return el.animate(
    [
      { opacity: 0 },
      { opacity: 1, offset: 0.1 },
      { opacity: 0.3, offset: 0.2 },
      { opacity: 1, offset: 0.35 },
      { opacity: 0.6, offset: 0.5 },
      { opacity: 1 },
    ],
    { duration: 320, easing: 'linear' },
  ).finished;
}

export function glowPop(el: HTMLElement) {
  return el.animate(
    [
      { transform: 'scale(0.6)', filter: 'brightness(3)', opacity: 0 },
      { transform: 'scale(1.08)', filter: 'brightness(1.6)', opacity: 1, offset: 0.6 },
      { transform: 'scale(1)', filter: 'brightness(1)', opacity: 1 },
    ],
    { duration: 420, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' },
  ).finished;
}

export async function typewriter(el: HTMLElement, text: string, msPerChar = 24) {
  el.textContent = '';
  for (const ch of text) {
    el.textContent += ch;
    await new Promise((r) => setTimeout(r, msPerChar));
  }
}
