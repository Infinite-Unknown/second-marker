/** Icon set drawn for this app: 20px grid, 1.5px stroke, round joins. */
const svg = (body: string, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  /** Wordmark: two mark bubbles, one filled. */
  mark: `<svg width="28" height="20" viewBox="0 0 28 20" aria-hidden="true"><ellipse cx="7.5" cy="10" rx="6.5" ry="4.5" fill="none" stroke="#E86A55" stroke-width="1.5"/><ellipse cx="20.5" cy="10" rx="6.5" ry="4.5" fill="#1F2023"/></svg>`,
  lock: svg('<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>', 16),
  upload: svg('<path d="M10 13V3.5"/><path d="M6 7.5l4-4 4 4"/><path d="M3.5 13.5v2a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-2"/>', 28),
  arrowRight: svg('<path d="M4 10h12"/><path d="M11.5 5.5L16 10l-4.5 4.5"/>'),
  arrowLeft: svg('<path d="M16 10H4"/><path d="M8.5 5.5L4 10l4.5 4.5"/>'),
  sliders: svg('<path d="M3.5 6h8"/><path d="M14.5 6h2"/><circle cx="13" cy="6" r="1.5"/><path d="M3.5 14h2"/><path d="M8.5 14h8"/><circle cx="7" cy="14" r="1.5"/>'),
  download: svg('<path d="M10 3.5V13"/><path d="M6 9l4 4 4-4"/><path d="M3.5 16.5h13"/>'),
  printer: svg('<path d="M6 7.5V3.5h8v4"/><rect x="3.5" y="7.5" width="13" height="6.5" rx="1"/><path d="M6 12h8v4.5H6z"/>'),
  key: svg('<circle cx="7" cy="10" r="3"/><path d="M10 10h6.5"/><path d="M14 10v2.5"/>'),
  restart: svg('<path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4 3.5v3h3"/>'),
};
