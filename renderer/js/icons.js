(function () {
  const F = 'fill="currentColor" stroke="none"';
  const P = {
    play: `<path d="M7 4.5v15l12-7.5z" ${F}/>`,
    pause: `<rect x="6" y="4.5" width="4" height="15" rx="1" ${F}/><rect x="14" y="4.5" width="4" height="15" rx="1" ${F}/>`,
    skipStart: `<path d="M6 5v14"/><path d="M20 5v14l-11-7z" ${F}/>`,
    skipEnd: `<path d="M18 5v14"/><path d="M4 5v14l11-7z" ${F}/>`,
    frameBack: `<path d="M15 6l-6 6 6 6"/>`,
    frameFwd: `<path d="M9 6l6 6-6 6"/>`,
    scissors: `<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/>`,
    trash: `<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>`,
    copy: `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>`,
    plus: `<path d="M12 5v14M5 12h14"/>`,
    undo: `<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`,
    redo: `<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`,
    folder: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
    file: `<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15h6"/>`,
    save: `<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>`,
    export: `<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>`,
    import: `<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>`,
    film: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>`,
    compress: `<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>`,
    crop: `<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>`,
    rotateCw: `<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>`,
    rotateCcw: `<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>`,
    flipH: `<path d="M12 3v18"/><path d="M8 7l-5 5 5 5zM16 7l5 5-5 5z"/>`,
    flipV: `<path d="M3 12h18"/><path d="M7 8l5-5 5 5zM7 16l5 5 5-5z"/>`,
    volume: `<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>`,
    mute: `<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>`,
    zoomIn: `<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>`,
    zoomOut: `<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>`,
    fit: `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`,
    speed: `<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>`,
    palette: `<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.5-.8 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.8-9-7.8z"/><circle cx="7.5" cy="11" r="1.2" ${F}/><circle cx="10.5" cy="7" r="1.2" ${F}/><circle cx="15" cy="7.5" r="1.2" ${F}/>`,
    sliders: `<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`,
    trim: `<path d="M8 4v16M16 4v16"/><path d="M3 9l5 3-5 3M21 9l-5 3 5 3"/>`,
    transform: `<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 3"/><path d="M9 9h6v6H9z"/>`,
    fade: `<path d="M3 20L12 4l9 16"/><path d="M3 20h18"/>`,
    x: `<path d="M18 6L6 18M6 6l12 12"/>`,
    check: `<path d="M20 6L9 17l-5-5"/>`,
    alert: `<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`,
    info: `<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>`,
    chevron: `<path d="M6 9l6 6 6-6"/>`,
    layers: `<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>`,
    reset: `<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>`,
    eye: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
    upload: `<path d="M7 18a4.5 4.5 0 0 1-.9-8.9A6 6 0 0 1 17.7 8 4.5 4.5 0 0 1 17 18"/><path d="M12 12v9M8.5 15.5L12 12l3.5 3.5"/>`,
    gpu: `<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M15 10h3M15 14h3M6 18v2M10 18v2M14 18v2"/>`,
    sparkle: `<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>`,
    play2: `<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z" ${F}/>`,
    wave: `<path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h0"/>`,
    music: `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
    type: `<path d="M4 7V4h16v3M9 20h6M12 4v16"/>`,
    magnet: `<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4M10 3v8a2 2 0 0 0 4 0V3"/>`,
    maximize: `<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>`,
    stop: `<rect x="6" y="6" width="12" height="12" rx="2" ${F}/>`,
    loop: `<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>`,
    image: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>`,
    send: `<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>`,
    headphones: `<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>`,
    transition: `<path d="M4 4h7v16H4zM13 4h7v16h-7z" opacity=".5"/><path d="M9 12h6M13 9l3 3-3 3"/>`,
    bold: `<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z"/>`,
    italic: `<path d="M19 4h-9M14 20H5M15 4L9 20"/>`,
    alignLeft: `<path d="M21 6H3M15 12H3M17 18H3"/>`,
    alignCenter: `<path d="M21 6H3M17 12H7M19 18H5"/>`,
    alignRight: `<path d="M21 6H3M21 12H9M21 18H7"/>`,
    rec: `<circle cx="12" cy="12" r="7" ${F}/>`,
    mic: `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>`,
    micOff: `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M3 3l18 18"/>`,
    flag: `<path d="M5 21V4"/><path d="M5 4h12l-2.5 4 2.5 4H5"/>`,
    camera: `<path d="M4 8a2 2 0 0 1 2-2h2l2-2h4l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>`,
    chart: `<path d="M3 20h18M6 20v-6M11 20V6M16 20v-9M21 20V3"/>`,
    monitor: `<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>`,
    window: `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M6.5 6.5h.01M9 6.5h.01"/>`,
    keyboard: `<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>`,
    bolt: `<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>`,
    target: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>`,
    gear: `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`,
  };

  function icon(name, cls = '') {
    return `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  }

  // Sustituye los <span data-icon="..."> estáticos del HTML.
  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.hydrated) return;
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
      el.dataset.hydrated = '1';
    });
  }

  window.Icons = { icon, hydrate };
})();
