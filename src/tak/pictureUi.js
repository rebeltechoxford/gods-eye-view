import { t, translateKnown } from '../i18n/index.js';

import { isCotStale } from './protocol/cot.js';
import { createPictureStorage } from './pictureStorage.js';
import { createPictureWorkflow } from './pictureWorkflow.js';

// Catalog strings are text, including when interpolated into trusted markup.
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ],
  );

export function createPicturePanel({
  container,
  client,
  overlay,
  context,
  isCurrent,
  markPrivate,
  signal,
}) {
  const section = document.createElement('details');
  section.className = 'tak-web-section';
  section.dataset.takSection = 'picture';
  section.innerHTML = `
    <summary>${escapeHtml(t('DEVICE TAK PICTURE ·'))} <span data-picture-count>0</span></summary>
    <p class="tak-web-hint">${escapeHtml(t('Keep one private historical picture for this account on this device. Save replaces the previous copy (500 items / 1 MiB). Own GPS, chat and position trails are excluded. Restoring never shares or updates live contacts.'))}</p>
    <label class="tak-web-check"><input type="checkbox" data-picture-consent> ${escapeHtml(t('I authorize retaining these private contacts and drawings in this browser profile until I delete them. Device storage is not application-encrypted.'))}</label>
    <div class="tak-web-row"><button type="button" data-picture-save>${escapeHtml(t('Save current picture'))}</button><button type="button" data-picture-restore>${escapeHtml(t('Restore saved picture'))}</button></div>
    <div class="tak-web-row"><button type="button" data-picture-hide>${escapeHtml(t('Hide historical picture'))}</button><button type="button" data-picture-delete>${escapeHtml(t('Delete saved picture'))}</button></div>
    <p class="tak-web-hint">${escapeHtml(t('For offline launch, separately save the app in Saved Maps or Offline Roads. Signing out hides and locks the copy; Delete removes it. Browser storage may be cleared or evicted by the device.'))}</p>
    <p data-picture-status class="tak-web-status" role="status" aria-live="polite"></p>
    <ul data-picture-list class="tak-web-roster"></ul>`;
  container.append(section);
  const $ = (selector) => section.querySelector(selector);
  const events = new AbortController();
  const storage = createPictureStorage({ context, isCurrent, signal });
  let rendered = null;
  let lastExpired = '';
  function render(state) {
    const contacts = state.picture?.contacts || [];
    const expired = contacts
      .map((c) => (isCotStale(c.event) ? '1' : '0'))
      .join('');
    $('[data-picture-count]').textContent = String(contacts.length);
    $('[data-picture-status]').textContent = state.busy
      ? t('Working with device storage…')
      : translateKnown(state.message);
    $('[data-picture-status]').classList.toggle('tak-web-error', state.error);
    for (const name of ['save', 'restore', 'delete'])
      $(`[data-picture-${name}]`).disabled = state.busy || state.locked;
    $('[data-picture-consent]').disabled = state.busy || state.locked;
    if (rendered === state.picture && expired === lastExpired) return;
    rendered = state.picture;
    lastExpired = expired;
    overlay.render(contacts, (c) => isCotStale(c.event));
    const rows = contacts.map((contact) => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.pictureUid = contact.uid;
      button.textContent = t(
        '{callsign} · {status} · observed {time} · {source}',
        {
          callsign: contact.callsign,
          status: isCotStale(contact.event) ? t('EXPIRED') : t('HISTORICAL'),
          time: new Date(contact.event.timeMs).toISOString(),
          source: contact.historical.source,
        },
      );
      row.append(button);
      return row;
    });
    $('[data-picture-list]').replaceChildren(...rows);
  }
  const workflow = createPictureWorkflow({
    client,
    storage,
    context,
    isCurrent,
    markPrivate,
    signal,
    onChange: render,
  });
  $('[data-picture-list]').addEventListener(
    'click',
    (event) => {
      const uid =
        event.target.closest('[data-picture-uid]')?.dataset.pictureUid;
      if (
        !uid ||
        !isCurrent(context) ||
        workflow.state().locked ||
        !workflow
          .state()
          .picture?.contacts.some((contact) => contact.uid === uid)
      )
        return;
      markPrivate();
      overlay.focus(uid);
    },
    { signal: events.signal },
  );
  const on = (name, action) =>
    $(`[data-picture-${name}]`).addEventListener('click', action, {
      signal: events.signal,
    });
  on('save', async () => {
    const consent = $('[data-picture-consent]').checked;
    // A subsequent save always requires a fresh explicit check, even on failure.
    $('[data-picture-consent]').checked = false;
    await workflow.save(consent);
  });
  on('restore', () => void workflow.restore());
  on('hide', () => workflow.hide());
  on('delete', () => void workflow.remove());
  render(workflow.state());
  const timer = setInterval(() => {
    if (workflow.state().picture) render(workflow.state());
  }, 15_000);
  return Object.freeze({
    state: workflow.state,
    hide() {
      $('[data-picture-consent]').checked = false;
      workflow.hide();
    },
    retire: workflow.retire,
    destroy() {
      clearInterval(timer);
      events.abort();
      workflow.destroy();
      overlay.destroy();
      section.remove();
    },
  });
}
