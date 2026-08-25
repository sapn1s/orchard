/**
 * One interruptible lifecycle for right-hand overlay surfaces.
 *
 * CSS owns the motion through `.slide-panel`; this helper owns display timing.
 * A hidden panel gets two painted frames at translateX(100%) before opening,
 * while a close keeps it displayed until transform settles. Calling the other
 * direction cancels every pending frame, listener and fallback, so motion
 * reverses from its current position instead of queueing stale completion work.
 */
export function createSlidePanel(panel, {
  useHidden = true,
  settledClass = null,
  settledRoot = document.documentElement,
} = {}) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fallbackMs = 300; // Longer than --panel-dur (.22s), only a stuck-state guard.
  let targetOpen = panel.classList.contains('open');
  let timer = null;
  let frame = null;
  let finish = null;

  function cancelPending() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (finish) panel.removeEventListener('transitionend', finish);
    finish = null;
  }

  function markSettled(open) {
    if (settledClass) settledRoot?.classList.toggle(settledClass, open);
    if (!open && useHidden) panel.hidden = true;
  }

  function afterMotion(open) {
    if (reducedMotion.matches) {
      markSettled(open);
      return;
    }
    finish = (event) => {
      if (event.target !== panel || event.propertyName !== 'transform') return;
      cancelPending();
      if (targetOpen === open) markSettled(open);
    };
    panel.addEventListener('transitionend', finish);
    timer = setTimeout(() => {
      cancelPending();
      if (targetOpen === open) markSettled(open);
    }, fallbackMs);
  }

  function open() {
    if (targetOpen) return;
    targetOpen = true;
    cancelPending();
    const wasHidden = useHidden && panel.hidden;
    if (wasHidden) panel.hidden = false;

    const start = () => {
      frame = null;
      if (!targetOpen) return;
      panel.classList.add('open');
      afterMotion(true);
    };
    // Newly displayed elements need a committed closed frame or the browser
    // coalesces the start/end values and no slide is visible.
    if (wasHidden && !reducedMotion.matches) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(start);
      });
    } else {
      start();
    }
  }

  function close() {
    if (!targetOpen && (useHidden ? panel.hidden : true)) return;
    targetOpen = false;
    cancelPending();
    // Reveal the live session before the overlay moves, never after it leaves.
    if (settledClass) settledRoot?.classList.remove(settledClass);
    panel.classList.remove('open');
    afterMotion(false);
  }

  return { open, close, isOpen: () => targetOpen };
}
