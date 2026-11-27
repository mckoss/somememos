// Keeps `--app-height` equal to the visible part of the window. On phones the
// on-screen keyboard shrinks the visual viewport without resizing the layout,
// so full-height screens (the editor) size themselves from this variable and
// stay above the keyboard, with their save controls visible.

export function startViewportTracking(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      // Keyboard open: the visual viewport is much shorter than the window.
      root.toggleAttribute('data-keyboard', window.innerHeight - vv.height > 120);
    });
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  return () => {
    cancelAnimationFrame(frame);
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
  };
}
