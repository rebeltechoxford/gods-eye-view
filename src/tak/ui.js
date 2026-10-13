import { MAX_COT_DOCUMENT_BYTES } from './cot.js';

/** Operator-facing import and local marker controls. No server connection implied. */
export function createTakPanel({
  listContacts, isStale, onImport, onMarker, onClear, onFocus,
}) {
  const root = document.createElement('section');
  root.className = 'tak-web-root';
  root.setAttribute('aria-label', 'TAK web client');
  root.innerHTML = [
    '<button class="tak-web-launcher" type="button" aria-expanded="false"',
    ' aria-controls="tak-web-panel">TAK <span>LOCAL</span></button>',
    '<section id="tak-web-panel" class="tak-web-panel" hidden',
    ' aria-label="TAK local operations">',
    '  <header class="tak-web-header"><strong>TAK OPERATIONS</strong>',
    '    <span>OFFLINE / LOCAL</span></header>',
    '  <p class="tak-web-explainer">CoT events render on the globe.',
    '    TAK Server connectivity is not configured.</p>',
    '  <label class="tak-web-label" for="tak-web-file">',
    '    Import .cot or .xml (up to 1 MiB)</label>',
    '  <input id="tak-web-file" data-tak-file type="file"',
    '    accept=".cot,.xml,text/xml,application/xml"/>',
    '  <label class="tak-web-label" for="tak-web-xml">',
    '    Or paste CoT XML</label>',
    '  <textarea id="tak-web-xml" data-tak-xml rows="3"',
    '    spellcheck="false" placeholder="&lt;event ...&gt;...&lt;/event&gt;"></textarea>',
    '  <button data-tak-import type="button" class="tak-web-primary">',
    '    Import XML to globe</button>',
    '  <div class="tak-web-subheading">LOCAL MARKER</div>',
    '  <form data-tak-marker-form>',
    '    <input data-tak-callsign maxlength="120" aria-label="Marker label"',
    '      placeholder="Label" required/>',
    '    <div class="tak-web-coordinates">',
    '      <input data-tak-lat aria-label="Latitude" type="number"',
    '        step="any" min="-90" max="90" placeholder="Latitude" required/>',
    '      <input data-tak-lon aria-label="Longitude" type="number"',
    '        step="any" min="-180" max="180" placeholder="Longitude" required/>',
    '    </div>',
    '    <button type="submit">Add local marker</button>',
    '  </form>',
    '  <div class="tak-web-roster-header">',
    '    <strong data-tak-count>CONTACTS · 0</strong>',
    '    <button type="button" data-tak-clear>Clear</button>',
    '  </div>',
    '  <div class="tak-web-roster" data-tak-list role="list"></div>',
    '  <div class="tak-web-status" data-tak-status role="status"',
    '    aria-live="polite">Local-only data is never uploaded or shared.</div>',
    '  <footer>LOCAL PREVIEW · NOT A CONNECTED TAK CLIENT</footer>',
    '</section>',
  ].join('');
  document.body.appendChild(root);

  const toggle = root.querySelector('.tak-web-launcher');
  const panel = root.querySelector('.tak-web-panel');
  const file = root.querySelector('[data-tak-file]');
  const input = root.querySelector('[data-tak-xml]');
  const count = root.querySelector('[data-tak-count]');
  const roster = root.querySelector('[data-tak-list]');
  const status = root.querySelector('[data-tak-status]');
  const markerForm = root.querySelector('[data-tak-marker-form]');
  let destroyed = false;

  function report(message, error = false) {
    if (destroyed) return;
    status.textContent = message;
    status.classList.toggle('tak-web-error', error);
  }

  function render() {
    if (destroyed) return;
    const contacts = listContacts();
    count.textContent = 'CONTACTS · ' + contacts.length;
    roster.replaceChildren();
    if (!contacts.length) {
      const empty = document.createElement('p');
      empty.className = 'tak-web-empty';
      empty.textContent = 'No imported contacts or local markers.';
      roster.appendChild(empty);
      return;
    }
    for (const contact of contacts.slice(0, 150)) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'tak-web-contact';
      entry.setAttribute('role', 'listitem');
      entry.title = 'Focus on ' + contact.callsign;
      const title = document.createElement('strong');
      title.textContent = contact.callsign;
      const coordinates = document.createElement('span');
      coordinates.textContent = contact.lat.toFixed(5) + ', ' +
        contact.lon.toFixed(5) + (isStale(contact) ? ' · STALE' : '');
      entry.append(title, coordinates);
      entry.addEventListener('click', () => onFocus(contact.uid));
      roster.appendChild(entry);
    }
    if (contacts.length > 150) {
      const limited = document.createElement('p');
      limited.className = 'tak-web-empty';
      limited.textContent = 'Showing first 150 of ' + contacts.length + '.';
      roster.appendChild(limited);
    }
  }

  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) render();
  });
  root.querySelector('[data-tak-import]').addEventListener('click', () => {
    try {
      report(onImport(input.value));
      input.value = '';
    } catch (error) {
      report(error?.message || 'Unable to import CoT.', true);
    }
  });
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    try {
      if (selected.size > MAX_COT_DOCUMENT_BYTES) {
        throw new Error('File exceeds the 1 MiB import limit.');
      }
      const text = await selected.text();
      if (destroyed) return;
      report(onImport(text));
    } catch (error) {
      report(error?.message || 'Unable to read CoT file.', true);
    } finally {
      file.value = '';
    }
  });
  markerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      report(onMarker({
        callsign: markerForm.querySelector('[data-tak-callsign]').value,
        lat: markerForm.querySelector('[data-tak-lat]').value,
        lon: markerForm.querySelector('[data-tak-lon]').value,
      }));
      markerForm.reset();
    } catch (error) {
      report(error?.message || 'Invalid marker.', true);
    }
  });
  root.querySelector('[data-tak-clear]').addEventListener('click', () => {
    onClear();
    report('Local contacts cleared.');
  });
  render();

  return Object.freeze({
    render,
    destroy() {
      destroyed = true;
      root.remove();
    },
  });
}
