export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const paths = {
  user: '<circle cx="12" cy="7" r="4"/><path d="M3 22v-2a9 9 0 0 1 18 0v2"/>',
  invoice: '<path d="M6 2h9l4 4v16H5V2h1Z"/><path d="M14 2v5h5M8 12h8M8 16h6"/>',
  headset: '<path d="M3 15v-3a9 9 0 0 1 18 0v3M3 13h3v8H3zM18 13h3v8h-3zM18 21c0 2-2 2-6 2"/>',
  pin: '<path d="M20 10c0 6-8 13-8 13S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  router: '<rect x="2" y="15" width="20" height="7" rx="2"/><path d="M6 18.5h.01M10 18.5h.01M14 18.5h4M12 15V9M9 9a4 4 0 0 1 6 0M6 6a8 8 0 0 1 12 0M3 3a12 12 0 0 1 18 0"/>',
  network: '<circle cx="4" cy="17" r="3"/><circle cx="20" cy="5" r="3"/><circle cx="20" cy="19" r="3"/><path d="m7 16 10-9M7 18l10 1"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  menu: '<path d="M3 5h18M3 12h18M3 19h18"/>',
  close: '<path d="m5 5 14 14M19 5 5 19"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H7l-5 3 1.5-6A9 9 0 1 1 21 11Z"/><path d="M7 10h10M7 14h7"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  image: '<rect x="2" y="3" width="20" height="18" rx="3"/><circle cx="8" cy="8" r="2"/><path d="m2 17 6-5 4 3 4-5 6 7"/>',
  settings: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/>',
  people: '<circle cx="8" cy="8" r="4"/><path d="M1 23v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8M18 16a6 6 0 0 1 5 6"/>',
  shield: '<path d="m12 2 9 4v6c0 6-9 11-9 11S3 18 3 12V6Z"/><path d="m8 12 3 3 5-6"/>'
};
export function icon(name, className = '') { return `<svg class="icon ${esc(className)}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.network}</svg>`; }
export async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'Não foi possível concluir.'); error.status = response.status; throw error; }
  return data;
}
export function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('visible'), 4500); }
