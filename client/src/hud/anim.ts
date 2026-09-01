/** Web Animations API helpers for HUD choreography. */

export function slideIn(el: HTMLElement, from: 'left' | 'right' | 'bottom' | 'top', delay = 0) {
  const offsets = { left: [-40, 0], right: [40, 0], bottom: [0, 40], top: [0, -40] } as const;
  const [x, y] = offsets[from];
  return el.animate(
    [
      { opacity: 0, transform: `translate(${x}px, ${y}px)` },
      { opacity: 1, transform: 'translate(0, 0)' },
    ],
    { duration: 260, delay, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1)', fill: 'backwards' },
  ).finished;
}

export function slideOut(el: HTMLElement, to: 'left' | 'right' | 'bottom' | 'top', delay = 0) {
  const offsets = { left: [-40, 0], right: [40, 0], bottom: [0, 40], top: [0, -40] } as const;
  const [x, y] = offsets[to];
  return el.animate(
    [
      { opacity: 1, transform: 'translate(0, 0)' },
      { opacity: 0, transform: `translate(${x}px, ${y}px)` },
    ],
    { duration: 180, delay, easing: 'ease-in', fill: 'forwards' },
  ).finished;
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
