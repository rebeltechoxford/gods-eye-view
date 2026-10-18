// The EMCON control: a button above the TAK launcher (and in the TAK panel
// header while the panel covers it), a banner while
// EMCON is on, and deliberate confirmations both ways. Entering is live:
// the received picture stays on screen. Leaving reloads the application so
// every feed, the TAK link and the saved-app worker restart cleanly.
import './emcon.css';

const ENTER_TEXT =
  'Pause app network requests: close active app connections and media, freeze data feeds, and use saved maps. Received contacts, markers, drawings and installed offline routes stay available. Requests already in flight, other browser contexts and the server may still transmit.';
const RADIO_TEXT =
  'This app cannot switch off your device radios. Turn on Airplane Mode, then check Wi-Fi and Bluetooth are off.';
const LEAVE_TEXT =
  'The app reloads, reconnects to the server and resumes data feeds. Session chat and contacts received over TAK are not kept across the reload.';

const clock = (iso) => {
  const date = iso ? new Date(iso) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toISOString().slice(11, 16) + 'Z'
    : '';
};

/**
 * @param {object} options
 * @param {HTMLElement} options.host Element the button is placed in.
 * @param {ReturnType<import('./state.js').createEmconState>} options.state
 * @param {(active:boolean) => Promise<void>} options.syncWorker
 * @param {() => void} [options.reload]
 */
export function mountEmconControl({
  host,
  state,
  syncWorker,
  reload = () => globalThis.location.reload(),
}) {
  if (!host) return { destroy() {} };
  const doc = host.ownerDocument;
  const makeButton = (className, role) => {
    const element = doc.createElement('button');
    element.type = 'button';
    element.className = className;
    element.dataset.emcon = role;
    return element;
  };
  const button = makeButton('gev-emcon-button', 'toggle');
  host.prepend(button);
  // The open TAK panel covers the floating button; its header carries one.
  const header = host.querySelector('.tak-web-header');
  const headerButton = header
    ? makeButton('gev-emcon-header-button', 'toggle-panel')
    : null;
  if (headerButton) header.append(headerButton);
  const buttons = [button, headerButton].filter(Boolean);

  const banner = doc.createElement('div');
  banner.className = 'gev-emcon-banner';
  banner.setAttribute('role', 'status');
  banner.dataset.emcon = 'banner';
  doc.body.append(banner);

  let dialog = null;
  const closeDialog = () => {
    dialog?.remove();
    dialog = null;
  };
  function confirm({ title, lines, accept, onAccept }) {
    closeDialog();
    dialog = doc.createElement('div');
    dialog.className = 'gev-emcon-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.dataset.emcon = 'dialog';
    const heading = doc.createElement('h2');
    heading.textContent = title;
    dialog.append(heading);
    for (const line of lines) {
      const p = doc.createElement('p');
      p.textContent = line;
      dialog.append(p);
    }
    const row = doc.createElement('div');
    row.className = 'gev-emcon-actions';
    const yes = doc.createElement('button');
    yes.type = 'button';
    yes.textContent = accept;
    yes.dataset.emcon = 'accept';
    yes.addEventListener('click', () => {
      closeDialog();
      onAccept();
    });
    const no = doc.createElement('button');
    no.type = 'button';
    no.textContent = 'Cancel';
    no.dataset.emcon = 'cancel';
    no.addEventListener('click', closeDialog);
    row.append(yes, no);
    dialog.append(row);
    doc.body.append(dialog);
    yes.focus();
  }

  let note = '';
  function render() {
    const record = state.current();
    const active = Boolean(record);
    for (const element of buttons) {
      element.textContent = active ? 'EMCON ON' : 'EMCON';
      element.setAttribute('aria-pressed', String(active));
      element.title = active
        ? 'Leave emissions control'
        : 'Emissions control: pause app network requests';
    }
    doc.documentElement.toggleAttribute('data-emcon', active);
    banner.hidden = !active;
    banner.textContent = active
      ? [
          'EMCON · APP REQUESTS PAUSED',
          record.since ? `since ${clock(record.since)}` : '',
          'feeds frozen',
          'Airplane Mode: turn it on',
          note,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  }

  async function enter() {
    const { persisted } = state.set(true);
    const persistence = persisted
      ? ''
      : 'will not survive a reload on this device';
    note = [persistence, 'saved-app protection pending']
      .filter(Boolean)
      .join(' · ');
    render();
    const confirmed = await syncWorker(true).catch(() => false);
    note = [
      persistence,
      confirmed ? 'saved app cache-only' : 'saved-app protection unconfirmed',
    ]
      .filter(Boolean)
      .join(' · ');
    render();
  }
  async function leave() {
    state.set(false);
    render();
    await syncWorker(false).catch(() => {});
    reload();
  }

  const onClick = () => {
    if (state.isActive())
      confirm({
        title: 'Leave EMCON?',
        lines: [LEAVE_TEXT],
        accept: 'Leave EMCON',
        onAccept: () => void leave(),
      });
    else
      confirm({
        title: 'Enter EMCON?',
        lines: [ENTER_TEXT, RADIO_TEXT],
        accept: 'Pause app requests',
        onAccept: () => void enter(),
      });
  };
  for (const element of buttons) element.addEventListener('click', onClick);
  const unsubscribe = state.subscribe(render);
  render();

  return {
    destroy() {
      unsubscribe();
      closeDialog();
      for (const element of buttons) element.remove();
      banner.remove();
      doc.documentElement.removeAttribute('data-emcon');
    },
  };
}
