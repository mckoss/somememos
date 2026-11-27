<script lang="ts" module>
  // Simple stroke icons, drawn on a 24×24 grid. Decorative: the control that
  // holds an icon always carries its own text or aria-label.
  const PATHS = {
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.35-4.35',
    hot: 'M12 3c1 3 4 5 4 9a4 4 0 0 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8Z M7 15a5 5 0 0 0 10 0',
    trending: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
    neglected: 'M12 7v5l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
    new: 'M12 5v14 M5 12h14',
    more: 'M5 12h.01 M12 12h.01 M19 12h.01',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
    edit: 'M4 20h4L19 9l-4-4L4 16v4Z M14 6l4 4',
    trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
    rename: 'M4 7V5h16v2 M12 5v14 M9 19h6',
    back: 'M15 5l-7 7 7 7',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    chevron: 'M9 6l6 6-6 6',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 11v5 M12 8h.01',
    upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
    download: 'M12 4v12 M7 11l5 5 5-5 M4 20h16',
    check: 'M5 12l5 5 9-10',
    close: 'M6 6l12 12 M18 6 6 18',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
    globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
    undo: 'M9 14 4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3',
    redo: 'M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3',
    save: 'M5 3h11l3 3v15H5V3Z M8 3v5h7V3 M8 21v-7h8v7',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    cloud: 'M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.4 4.6 4.6 0 0 0 7 18.5Z',
    'cloud-check':
      'M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.4 4.6 4.6 0 0 0 7 18.5Z M9.5 13.8l2 2 3.6-3.8',
    'cloud-up':
      'M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.4 4.6 4.6 0 0 0 7 18.5Z M12 16.5v-5 M9.6 13.6 12 11.2l2.4 2.4',
    'cloud-off':
      'M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.4 4.6 4.6 0 0 0 7 18.5Z M3.5 3.5l17 17',
    sync: 'M19.5 12a7.5 7.5 0 0 1-13.4 4.6 M4.5 12a7.5 7.5 0 0 1 13.4-4.6 M18.3 3.6v4h-4 M5.7 20.4v-4h4',
    alert: 'M12 3.5 2.5 20h19L12 3.5Z M12 10v4.5 M12 17.5h.01',
  } as const;
  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d={PATHS[name]} />
</svg>
