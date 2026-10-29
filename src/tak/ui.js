import { t } from '../i18n/index.js';
import { MAX_COT_DOCUMENT_BYTES } from './protocol/cot.js';
import { describePosition } from './position.js';
import {
  ALL_CHAT_ROOMS,
  TAK_ROLES,
  TAK_TEAMS,
  TAK_TEAM_COLORS,
} from './protocol/builders.js';

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

const ROSTER_LIMIT = 150;
const CHAT_LIMIT = 60;

const LINK_LABELS = Object.freeze({
  idle: 'LOCAL',
  connecting: 'CONNECTING',
  open: 'LIVE',
  reconnecting: 'RECONNECTING',
  refused: 'REFUSED',
  closed: 'LOCAL',
});

const PANEL_HTML = () => `
<button class="tak-web-launcher" type="button" aria-expanded="false" aria-controls="tak-web-panel">TAK <span data-tak-badge>${escapeHtml(t('LOCAL'))}</span></button>
<section id="tak-web-panel" class="tak-web-panel" hidden aria-label="${escapeHtml(t('TAK operations'))}">
  <header class="tak-web-header">
    <strong>${escapeHtml(t('TAK OPERATIONS'))}</strong>
    <span data-tak-link role="status" aria-live="polite">${escapeHtml(t('LOCAL'))}</span>
  </header>
  <p class="tak-web-hint" data-tak-device-state>${escapeHtml(t('Foreground device state…'))}</p>
  <p class="tak-web-explainer" data-tak-gateway>${escapeHtml(t('Checking gateway…'))}</p>
  <label class="tak-web-check"><input type="checkbox" data-tak-visible checked/> ${escapeHtml(t('Show TAK layer on globe'))}</label>
  <details class="tak-web-section" data-tak-section="privacy" open>
    <summary>${escapeHtml(t('PRIVATE DATA PERMISSIONS'))}</summary>
    <label class="tak-web-check"><input type="checkbox" data-tak-disclosure="ai"/> ${escapeHtml(t('Allow AI / voice providers to receive private locations, context and map images for this page session'))}</label>
    <label class="tak-web-check"><input type="checkbox" data-tak-disclosure="sharing"/> ${escapeHtml(t('Allow public links, scene capture / export and embedded view sharing to include private locations for this page session'))}</label>
    <label class="tak-web-check"><input type="checkbox" data-tak-disclosure="recording"/> ${escapeHtml(t('Allow recording mode to include private data and locations for this page session'))}</label>
    <button type="button" data-tak-revoke>${escapeHtml(t('Revoke all permissions'))}</button>
  </details>
  <p class="tak-web-hint" data-tak-privacy>${escapeHtml(t('Privacy protection starts when TAK data is loaded.'))}</p>
  <details class="tak-web-section" data-tak-section="phone">
    <summary>${escapeHtml(t('PHONE EUD / INSTALL'))}</summary>
    <button type="button" data-tak-install>${escapeHtml(t('Install / home screen'))}</button>
    <p class="tak-web-hint" data-tak-install-state>${escapeHtml(t('Private HTTPS is required on a real phone. Use Saved Maps to retain approved maps and the app for offline launch. Keep the app visible for device GPS; reliable background tracking requires native support.'))}</p>
  </details>

  <details class="tak-web-section" data-tak-section="identity">
    <summary>${escapeHtml(t('IDENTITY ·'))} <span data-tak-whoami></span></summary>
    <form data-tak-identity-form>
      <input data-tak-callsign-self maxlength="40" aria-label="${escapeHtml(t('Callsign'))}" placeholder="${escapeHtml(t('Callsign'))}" required/>
      <div class="tak-web-row">
        <select data-tak-team aria-label="${escapeHtml(t('Team'))}"></select>
        <select data-tak-role aria-label="${escapeHtml(t('Role'))}"></select>
      </div>
      <button type="submit">${escapeHtml(t('Save identity'))}</button>
      <p class="tak-web-hint" data-tak-uid></p>
    </form>
  </details>

  <details class="tak-web-section" data-tak-section="network">
    <summary>${escapeHtml(t('NETWORK'))}</summary>
    <form data-tak-connect-form>
      <input data-tak-token type="password" autocomplete="off" aria-label="${escapeHtml(t('Gateway token (if configured)'))}" placeholder="${escapeHtml(t('Gateway token (if configured)'))}"/>
      <div class="tak-web-row">
        <button type="submit" data-tak-connect>${escapeHtml(t('Connect'))}</button>
        <button type="button" data-tak-disconnect>${escapeHtml(t('Disconnect'))}</button>
        <button type="button" data-tak-logout hidden>${escapeHtml(t('Sign out'))}</button>
      </div>
    </form>
    <p class="tak-web-hint" data-tak-uplinks></p>
  </details>

  <details class="tak-web-section" data-tak-section="position" open>
    <summary>${escapeHtml(t('MY POSITION'))}</summary>
    <p class="tak-web-hint" data-tak-fix>${escapeHtml(t('No position set.'))}</p>
    <div class="tak-web-row">
      <button type="button" data-tak-gps aria-pressed="false">${escapeHtml(t('Use device GPS'))}</button>
      <button type="button" data-tak-fix-center>${escapeHtml(t('Set to map center'))}</button>
    </div>
    <label class="tak-web-check"><input type="checkbox" data-tak-sa/> ${escapeHtml(t('Broadcast my position (SA)'))}</label>
    <p class="tak-web-hint" data-tak-presence hidden></p>
    <button type="button" class="tak-web-alert" data-tak-emergency aria-pressed="false">${escapeHtml(t('RAISE 911 ALERT'))}</button>
  </details>

  <details class="tak-web-section" data-tak-section="marker">
    <summary>${escapeHtml(t('DROP MARKER'))}</summary>
    <form data-tak-marker-form>
      <input data-tak-callsign maxlength="120" aria-label="${escapeHtml(t('Marker label'))}" placeholder="${escapeHtml(t('Label'))}" required/>
      <div class="tak-web-row">
        <input data-tak-lat aria-label="${escapeHtml(t('Latitude'))}" type="number" step="any" min="-90" max="90" placeholder="${escapeHtml(t('Latitude'))}" required/>
        <input data-tak-lon aria-label="${escapeHtml(t('Longitude'))}" type="number" step="any" min="-180" max="180" placeholder="${escapeHtml(t('Longitude'))}" required/>
      </div>
      <input data-tak-remarks maxlength="500" aria-label="${escapeHtml(t('Remarks'))}" placeholder="${escapeHtml(t('Remarks (optional)'))}"/>
      <div class="tak-web-row">
        <button type="button" data-tak-marker-center>${escapeHtml(t('Map center'))}</button>
        <button type="submit">${escapeHtml(t('Add marker'))}</button>
      </div>
      <label class="tak-web-check"><input type="checkbox" data-tak-marker-broadcast/> ${escapeHtml(t('Share with network'))}</label>
    </form>
  </details>

  <div class="tak-web-roster-header">
    <strong data-tak-count>${escapeHtml(t('CONTACTS · 0'))}</strong>
    <button type="button" data-tak-clear>${escapeHtml(t('Clear'))}</button>
  </div>
  <p class="tak-web-hint" data-tak-resources hidden></p>
  <input data-tak-filter aria-label="${escapeHtml(t('Filter contacts'))}" placeholder="${escapeHtml(t('Filter callsign…'))}"/>
  <div class="tak-web-roster" data-tak-list role="list"></div>

  <details class="tak-web-section" data-tak-section="chat">
    <summary>CHAT · ${ALL_CHAT_ROOMS.toUpperCase()} <span data-tak-chat-count></span></summary>
    <div class="tak-web-chat" data-tak-chat role="log" aria-live="polite"></div>
    <form data-tak-chat-form class="tak-web-row">
      <input data-tak-chat-input maxlength="1000" aria-label="${escapeHtml(t('Chat message'))}" placeholder="${escapeHtml(t('Message'))}" required/>
      <button type="submit">${escapeHtml(t('Send'))}</button>
    </form>
  </details>

  <details class="tak-web-section" data-tak-section="submissions">
    <summary>${escapeHtml(t('NETWORK SUBMISSIONS'))} <span data-tak-submission-count></span></summary>
    <p class="tak-web-hint">${escapeHtml(t('Submitted means a local uplink write succeeded. Peer receipt is unconfirmed. Queued attempts expire within 30 seconds; disconnected attempts are never retried by this page.'))}</p>
    <div class="tak-web-chat" data-tak-submissions aria-label="${escapeHtml(t('Recent network submissions'))}"></div>
  </details>

  <details class="tak-web-section" data-tak-section="import">
    <summary>${escapeHtml(t('IMPORT COT FILE'))}</summary>
    <label class="tak-web-label" for="tak-web-file">${escapeHtml(t('Import .cot or .xml (up to 1 MiB, stays local)'))}</label>
    <input id="tak-web-file" data-tak-file type="file" accept=".cot,.xml,text/xml,application/xml"/>
    <label class="tak-web-label" for="tak-web-xml">${escapeHtml(t('Or paste CoT XML'))}</label>
    <textarea id="tak-web-xml" data-tak-xml rows="3" spellcheck="false" placeholder="&lt;event ...&gt;...&lt;/event&gt;"></textarea>
    <button data-tak-import type="button" class="tak-web-primary">${escapeHtml(t('Import XML to globe'))}</button>
  </details>

  <div class="tak-web-status" data-tak-status role="status" aria-live="polite">${escapeHtml(t('Imported files and unshared markers never leave this page.'))}</div>
  <footer data-tak-footer>${escapeHtml(t('NOT VERIFIED TACTICAL DATA · OPERATOR JUDGEMENT REQUIRED'))}</footer>
</section>`;

function describeGateway(link, gatewayInfo) {
  const g = link.gateway || gatewayInfo;
  if (!g) return 'Gateway status unknown.';
  if (g.enabled === false) {
    return `Gateway off (${g.reason || 'disabled'}). Running local-only: imports and markers stay on this page. Set TAK_GATEWAY=1 to enable mesh/TAK Server links.`;
  }
  return link.state === 'open'
    ? 'Connected to the TAK gateway. Peer delivery depends on authorized uplinks and is not acknowledged by this client.'
    : 'Gateway available. Connect to exchange CoT with mesh and TAK Server peers.';
}

const SERVER_ENCODINGS = Object.freeze({
  requested: ' · requesting TAK protocol v1',
  v1: ' · TAK protocol v1',
});

function describeDevicePresence(link) {
  if (!link.gateway?.server?.deviceStreams && !link.presenceStop) return '';
  switch (link.presenceStop?.state) {
    case 'requested':
      return 'Device route stop requested; gateway confirmation pending. New position sending waits.';
    case 'confirmed':
      return 'Gateway confirmed this tab’s device route stop. Another tab may still publish.';
    case 'refused':
      return 'Gateway refused this tab’s device route stop; its browser connection was closed.';
    case 'unconfirmed':
      return 'Device route stop unconfirmed; browser connection closed.';
    default:
      return link.gateway?.server?.presence?.active
        ? 'Device route active for this UID; another tab may own it. Peer registration is unconfirmed.'
        : 'No active device presence reported; shared receive feed selected.';
  }
}

/** Gateway uplink summary; protocol counts are gateway observations only. */
export function describeUplinks(link) {
  const g = link.gateway;
  if (!g || g.enabled === false) return '';
  const parts = [];
  const mesh = g.mesh;
  const refused =
    (mesh?.protobufRejected || 0) + (mesh?.protobufUnsupported || 0);
  parts.push(
    mesh
      ? `Mesh ${mesh.group}: ${mesh.state} (rx ${mesh.rx} / tx ${mesh.tx}` +
          (mesh.protobuf ? ` · TAK v1 ${mesh.protobuf}` : '') +
          (mesh.protobufIncomplete
            ? ` · partly decoded ${mesh.protobufIncomplete}`
            : '') +
          (refused ? ` · refused ${refused}` : '') +
          ')'
      : 'Mesh: off',
  );
  parts.push(
    g.server
      ? `Server ${g.server.endpoint}: ${g.server.state}` +
          (SERVER_ENCODINGS[g.server.encoding] || '') +
          (g.server.protobufIncomplete
            ? ` · partly decoded ${g.server.protobufIncomplete}`
            : '')
      : 'TAK Server: off',
  );
  const presence = describeDevicePresence(link);
  if (presence) parts.push(presence);
  parts.push(`Bridge: ${g.bridge ? 'on' : 'off'} · Browsers: ${g.browsers}`);
  return parts.join('\n');
}

/**
 * Operator panel. All dynamic text goes through textContent.
 * @param {object} deps
 * @param {ReturnType<import('./client.js').createTakClient>} deps.client
 * @param {{focus:(uid:string)=>void, setVisible:(v:boolean)=>void, isVisible:()=>boolean}} deps.overlay
 * @param {()=>({lat:number, lon:number}|null)} deps.getMapCenter
 * @param {{start:(cb:Function, err:Function)=>boolean, stop:()=>void}} deps.geolocation
 * @param {()=>({enabled:boolean, reason?:string}|null)} deps.gatewayInfo
 */
export function createTakPanel({
  client,
  overlay,
  getMapCenter,
  geolocation,
  gatewayInfo,
  privacy,
  connect,
  mobile,
  logout,
  clearRetainedPicture = () => {},
}) {
  const root = document.createElement('section');
  root.className = 'tak-web-root';
  root.setAttribute('aria-label', t('TAK web client'));
  root.innerHTML = PANEL_HTML();
  document.body.appendChild(root);
  const $ = (selector) => root.querySelector(selector);

  const toggle = $('.tak-web-launcher');
  const panel = $('.tak-web-panel');
  const status = $('[data-tak-status]');
  const teamSelect = $('[data-tak-team]');
  const roleSelect = $('[data-tak-role]');
  for (const team of TAK_TEAMS) teamSelect.append(new Option(team, team));
  for (const role of TAK_ROLES) roleSelect.append(new Option(role, role));
  let destroyed = false;
  let frame = 0;
  let gpsOn = false;
  let renderedChat = null;
  let renderedReject = null;
  let connectAttempt = null;
  let reportedEvictions = 0;
  let reportedRejections = 0;
  let renderedSubmissions = null;

  function report(message, error = false) {
    if (destroyed) return;
    status.textContent = message;
    status.classList.toggle('tak-web-error', error);
  }

  function guard(action, fallback) {
    return (...args) => {
      try {
        const message = action(...args);
        if (message) report(message);
      } catch (error) {
        report(error?.message || fallback, true);
      }
    };
  }

  function fillIdentity() {
    const id = client.identity();
    $('[data-tak-callsign-self]').value = id.callsign;
    teamSelect.value = id.team;
    roleSelect.value = id.role;
    $('[data-tak-uid]').textContent = t('Device uid {uid}', { uid: id.uid });
  }

  function clearPrivateInputs() {
    clearRetainedPicture();
    for (const input of root.querySelectorAll(
      'input:not([type="checkbox"]), textarea',
    ))
      input.value = '';
    for (const record of rosterRows.values()) record.row.remove();
    rosterRows.clear();
    $('[data-tak-chat]').replaceChildren();
    $('[data-tak-submissions]').replaceChildren();
    $('[data-tak-submission-count]').textContent = '';
    renderedSubmissions = null;
    $('[data-tak-fix]').textContent = t('No position set.');
    $('[data-tak-presence]').hidden = true;
    $('[data-tak-presence]').textContent = '';
    $('[data-tak-whoami]').textContent = '';
    $('[data-tak-uid]').textContent = '';
    $('[data-tak-sa]').checked = false;
    for (const input of root.querySelectorAll('[data-tak-disclosure]'))
      input.checked = false;
    $('[data-tak-marker-broadcast]').checked = false;
    gpsOn = false;
    const gps = $('[data-tak-gps]');
    gps.setAttribute('aria-pressed', 'false');
    gps.textContent = t('Use device GPS');
    const emergency = $('[data-tak-emergency]');
    emergency.setAttribute('aria-pressed', 'false');
    emergency.textContent = t('RAISE 911 ALERT');
  }

  const rosterRows = new Map();
  const rosterNote = document.createElement('p');
  rosterNote.className = 'tak-web-empty';
  function createRosterRow(uid) {
    const row = document.createElement('div');
    row.className = 'tak-web-contact-row';
    row.setAttribute('role', 'listitem');
    row.dataset.takUid = uid;
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'tak-web-contact';
    const title = document.createElement('strong');
    const swatch = document.createElement('i');
    const label = document.createTextNode('');
    title.append(swatch, label);
    const meta = document.createElement('span');
    entry.append(title, meta);
    entry.addEventListener('click', () => overlay.focus(uid));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tak-web-remove';
    remove.textContent = '×';
    remove.addEventListener(
      'click',
      guard(() => {
        const contact = client.store.get(uid);
        if (!contact) return '';
        const result = client.removeContact(uid);
        return result.sent
          ? `Deletion sent to gateway for ${contact.callsign}; peer delivery is not confirmed.`
          : `Removed ${contact.callsign} locally.`;
      }, 'Unable to remove contact.'),
    );
    row.append(entry, remove);
    return { row, entry, swatch, label, meta, remove };
  }
  function renderRoster() {
    const filter = $('[data-tak-filter]').value.trim().toLowerCase();
    const contacts = client.store
      .list()
      .filter((c) => !filter || c.callsign.toLowerCase().includes(filter));
    $('[data-tak-count]').textContent = t('CONTACTS · {count}', {
      count: client.store.count(),
    });
    const roster = $('[data-tak-list]');
    const visible = contacts.slice(0, ROSTER_LIMIT);
    const wanted = new Set(visible.map((contact) => contact.uid));
    for (const [uid, record] of rosterRows) {
      if (!wanted.has(uid)) {
        record.row.remove();
        rosterRows.delete(uid);
      }
    }
    for (const [index, contact] of visible.entries()) {
      let record = rosterRows.get(contact.uid);
      if (!record) {
        record = createRosterRow(contact.uid);
        rosterRows.set(contact.uid, record);
      }
      const { row, entry, swatch, label, meta, remove } = record;
      entry.classList.toggle('tak-web-contact-emergency', contact.emergency);
      entry.title = t('Focus on {callsign}', { callsign: contact.callsign });
      label.data = contact.callsign;
      swatch.className = `tak-web-swatch tak-web-${contact.origin === 'self' ? 'self' : contact.affiliation}`;
      meta.textContent = [
        `${contact.point.lat.toFixed(5)}, ${contact.point.lon.toFixed(5)}`,
        contact.origin.toUpperCase(),
        contact.event.detail.group?.name || null,
        client.store.isStale(contact) ? 'STALE' : null,
        contact.emergency ? 'EMERGENCY' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      remove.hidden = contact.origin === 'self';
      remove.title = client.isOwnMarker(contact.uid)
        ? t('Delete {callsign} for everyone', { callsign: contact.callsign })
        : t('Remove {callsign} from this page', { callsign: contact.callsign });
      remove.setAttribute('aria-label', remove.title);
      // Keep existing buttons attached across status, stale and position updates.
      // Replacing them between pointerdown/up loses a legitimate phone tap.
      const current = roster.children[index];
      if (current !== row) roster.insertBefore(row, current || null);
    }
    const note = !contacts.length
      ? filter
        ? 'No contacts match.'
        : 'No contacts yet.'
      : contacts.length > ROSTER_LIMIT
        ? `Showing first ${ROSTER_LIMIT} of ${contacts.length}.`
        : '';
    if (note) {
      rosterNote.textContent = note;
      if (rosterNote.parentNode !== roster) roster.append(rosterNote);
    } else rosterNote.remove();
  }

  function renderChat() {
    const chats = client.store.chats();
    $('[data-tak-chat-count]').textContent = chats.length
      ? `(${chats.length})`
      : '';
    const newest = chats.at(-1) || null;
    if (newest === renderedChat && chats.length) return;
    renderedChat = newest;
    const log = $('[data-tak-chat]');
    log.replaceChildren();
    for (const chat of chats.slice(-CHAT_LIMIT)) {
      const line = document.createElement('p');
      line.className = chat.outgoing ? 'tak-web-chat-out' : 'tak-web-chat-in';
      const who = document.createElement('strong');
      who.textContent = `${chat.senderCallsign} `;
      const when = document.createElement('time');
      when.textContent =
        new Date(chat.timeMs).toISOString().slice(11, 16) + 'Z ';
      line.append(when, who, document.createTextNode(chat.text));
      log.append(line);
    }
    log.scrollTop = log.scrollHeight;
  }

  function renderSubmissions() {
    const items = client.submissions?.() || [];
    $('[data-tak-submission-count]').textContent = items.length
      ? `(${items.length})`
      : '';
    const newest = items.at(-1);
    const signature = items
      .map(
        (item) =>
          `${item.id}:${item.updatedAtMs}:${item.state}:${JSON.stringify(item.routes)}`,
      )
      .join('|');
    if (signature === renderedSubmissions) return;
    renderedSubmissions = signature;
    const list = $('[data-tak-submissions]');
    list.replaceChildren();
    for (const item of items.slice(-30).reverse()) {
      const row = document.createElement('p');
      row.dataset.submissionId = item.id;
      row.dataset.submissionState = item.state;
      const routes = item.routes
        .map(
          (route) =>
            `${route.id}: ${route.state}${route.reason ? ` (${route.reason})` : ''}`,
        )
        .join('; ');
      const label = client.store.get(item.uid)?.callsign || item.uid.slice(-12);
      row.textContent = `${new Date(item.createdAtMs).toISOString().slice(11, 19)}Z · ${item.kind.toUpperCase()} · ${label} · ${item.state.toUpperCase()}${item.reason ? ` · ${item.reason}` : ''}${routes ? ` · ${routes}` : ''}`;
      list.append(row);
    }
    if (!newest) list.textContent = t('No network submissions this session.');
  }

  function render() {
    frame = 0;
    if (destroyed) return;
    const link = client.link();
    const canShare = client.canShare?.() !== false;
    for (const selector of [
      '[data-tak-sa]',
      '[data-tak-emergency]',
      '[data-tak-marker-broadcast]',
      '[data-tak-chat-input]',
      '[data-tak-chat-form] button',
    ]) {
      const control = $(selector);
      control.disabled = !canShare;
      if (!canShare && control.type === 'checkbox') control.checked = false;
    }
    const device = mobile.state();
    $('[data-tak-connect]').disabled = !gatewayInfo();
    const operatorSession =
      gatewayInfo()?.sessionAuthenticated || link.gateway?.sessionAuthenticated;
    const reopenRequired = gatewayInfo()?.reopenRequired === true;
    $('[data-tak-logout]').hidden = !operatorSession && !reopenRequired;
    $('[data-tak-logout]').textContent = reopenRequired
      ? t('Reopen / sign in')
      : t('Sign out');
    $('[data-tak-logout]').disabled = logoutPending;
    const tokenInput = $('[data-tak-token]');
    tokenInput.hidden = !!operatorSession || reopenRequired;
    if (operatorSession) tokenInput.value = '';
    if (link.lastReject && link.lastReject !== renderedReject) {
      renderedReject = link.lastReject;
      report(
        `Gateway rejected command: ${link.lastReject.reason.slice(0, 240)}`,
        true,
      );
    }
    const resources = client.store.resourceStats?.();
    if (resources) {
      const { evictedContacts, rejectedContacts } = resources;
      const notice = $('[data-tak-resources]');
      notice.hidden = !evictedContacts && !rejectedContacts;
      const message = `Contact capacity: ${evictedContacts} older contacts removed; ${rejectedContacts} updates refused because they exceed resource limits. Remaining contacts stay available.`;
      if (!notice.hidden) notice.textContent = message;
      if (
        evictedContacts > reportedEvictions ||
        rejectedContacts > reportedRejections
      )
        report(message, true);
      reportedEvictions = evictedContacts;
      reportedRejections = rejectedContacts;
    }
    const label = device.online
      ? LINK_LABELS[link.state] || link.state.toUpperCase()
      : 'OFFLINE';
    $('[data-tak-badge]').textContent = label;
    $('[data-tak-link]').textContent =
      link.detail && link.state !== 'open'
        ? `${label} · ${link.detail}`
        : label;
    root.dataset.link = link.state;
    $('[data-tak-gateway]').textContent = describeGateway(link, gatewayInfo());
    const account = gatewayInfo();
    if (account?.multiOperator)
      $('[data-tak-gateway]').textContent +=
        ` Account ${account.principal} · ${account.role === 'observer' ? 'RECEIVE ONLY — local drafts and maps remain available.' : 'OPERATOR'}`;
    $('[data-tak-uplinks]').textContent = describeUplinks(link);
    const presence = describeDevicePresence(link);
    $('[data-tak-presence]').hidden = !presence;
    $('[data-tak-presence]').textContent = presence;
    const id = client.identity();
    const whoami = $('[data-tak-whoami]');
    whoami.textContent = `${id.callsign} · ${id.team}`;
    whoami.style.borderBottomColor = TAK_TEAM_COLORS[id.team] || 'transparent';
    $('[data-tak-fix]').textContent = describePosition(client.fix(), {
      foreground: device.foreground,
      gpsActive: gpsOn,
    });
    $('[data-tak-device-state]').textContent =
      `${device.online ? 'BROWSER ONLINE' : 'OFFLINE / LOCAL'} · ${device.foreground ? 'FOREGROUND' : 'BACKGROUND · GPS paused'} · ${device.standalone ? 'INSTALLED' : 'BROWSER'}${device.secure ? '' : ' · PHONE HTTPS REQUIRED'}`;
    $('[data-tak-install]').textContent = device.standalone
      ? t('Installed on this device')
      : device.installAvailable
        ? t('Install EUD')
        : t('Install / home screen');
    if (device.viewportHeight)
      root.style.setProperty(
        '--tak-viewport-height',
        `${Math.round(device.viewportHeight)}px`,
      );
    root.style.setProperty(
      '--tak-keyboard-inset',
      `${Math.round(device.keyboardInset)}px`,
    );
    $('[data-tak-sa]').checked = client.saEnabled();
    const gps = $('[data-tak-gps]');
    gps.setAttribute('aria-pressed', String(gpsOn));
    gps.textContent = gpsOn ? t('Stop device GPS') : t('Use device GPS');
    const emergency = $('[data-tak-emergency]');
    emergency.setAttribute('aria-pressed', String(client.emergencyActive()));
    emergency.textContent = client.emergencyActive()
      ? t('CANCEL ALERT')
      : t('RAISE 911 ALERT');
    $('[data-tak-visible]').checked = overlay.isVisible();
    const policy = privacy.state();
    const permitted = [];
    const permissionLabels = {
      ai: 'AI / voice',
      sharing: 'links / scenes',
      recording: 'recording',
    };
    for (const input of root.querySelectorAll('[data-tak-disclosure]')) {
      const scope = input.dataset.takDisclosure;
      input.checked = policy.permissions?.[scope] === true;
      if (input.checked) permitted.push(permissionLabels[scope]);
    }
    $('[data-tak-privacy]').textContent = permitted.length
      ? t(
          'Allowed this page session: {permissions}. Other uses stay protected.',
          { permissions: permitted.join(', ') },
        )
      : policy.private
        ? t(
            'Protected: AI, sharing, scene capture/export and recording are blocked. Clearing or hiding contacts keeps locations protected until reload.',
          )
        : t('Privacy protection starts when TAK data is loaded.');
    if (!panel.hidden) {
      renderRoster();
      renderChat();
      renderSubmissions();
    }
  }

  function scheduleRender() {
    if (destroyed || frame) return;
    frame = requestAnimationFrame(render);
  }

  // --- wiring --------------------------------------------------------------
  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      renderedChat = null;
      render();
    }
  });
  $('[data-tak-visible]').addEventListener('change', (event) =>
    overlay.setVisible(event.target.checked),
  );
  for (const input of root.querySelectorAll('[data-tak-disclosure]'))
    input.addEventListener('change', () => {
      privacy.authorize(input.checked, input.dataset.takDisclosure);
      render();
    });
  $('[data-tak-revoke]').addEventListener('click', () => {
    privacy.authorize(false);
    render();
  });
  $('[data-tak-filter]').addEventListener('input', () => renderRoster());
  $('[data-tak-install]').addEventListener('click', async () => {
    try {
      const result = await mobile.install();
      if (destroyed || result === 'closed') return;
      const installMessage =
        result === 'installed'
          ? 'This app is already running from the home screen.'
          : result === 'accepted'
            ? 'Installation requested. Keep using the app while your browser completes it.'
            : result === 'dismissed'
              ? 'Installation dismissed. The app remains available in this browser.'
              : result === 'https-required'
                ? 'Open the approved private HTTPS address on your phone before installing or using GPS.'
                : 'Use your browser menu to install. On iPhone/iPad: Share → Add to Home Screen. On Android: menu → Install app / Add to Home screen.';
      $('[data-tak-install-state]').textContent = installMessage;
    } catch {
      report(
        'The browser could not complete installation. Use its home screen menu.',
        true,
      );
    }
  });

  $('[data-tak-identity-form]').addEventListener(
    'submit',
    guard((event) => {
      event.preventDefault();
      const id = client.setIdentity({
        callsign: $('[data-tak-callsign-self]').value,
        team: teamSelect.value,
        role: roleSelect.value,
      });
      fillIdentity();
      return `Identity saved: ${id.callsign} (${id.team}, ${id.role}).`;
    }, 'Invalid identity.'),
  );

  $('[data-tak-connect-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    connectAttempt?.abort();
    const attempt = new AbortController();
    connectAttempt = attempt;
    try {
      report('Connecting to the TAK gateway…');
      await connect($('[data-tak-token]').value.trim() || null, attempt.signal);
    } catch (error) {
      if (!attempt.signal.aborted && !destroyed)
        report(error?.message || 'Unable to connect.', true);
    } finally {
      if (connectAttempt === attempt) connectAttempt = null;
    }
  });
  $('[data-tak-disconnect]').addEventListener(
    'click',
    guard(() => {
      connectAttempt?.abort();
      client.disconnect();
      return 'Disconnected. Working local-only.';
    }, 'Unable to disconnect.'),
  );
  let logoutPending = false;
  $('[data-tak-logout]').addEventListener('click', async () => {
    if (logoutPending) return;
    logoutPending = true;
    $('[data-tak-logout]').disabled = true;
    connectAttempt?.abort();
    geolocation.stop();
    gpsOn = false;
    client.disconnect();
    client.clearPrivateState();
    privacy.authorize(false);
    clearPrivateInputs();
    report('Signing out. Local tactical data cleared.');
    try {
      await logout();
    } catch (error) {
      report(
        error?.message ||
          'Server sign-out could not be confirmed; reopen while connected.',
        true,
      );
    } finally {
      logoutPending = false;
      render();
    }
  });

  $('[data-tak-gps]').addEventListener('click', () => {
    if (gpsOn) {
      geolocation.stop();
      client.refreshPositionAvailability();
      gpsOn = false;
      report('Device GPS stopped. Last position kept.');
      scheduleRender();
      return;
    }
    const started = geolocation.start(
      (fix) => client.setFix({ ...fix, source: 'GPS' }),
      (message) => {
        geolocation.stop();
        client.refreshPositionAvailability();
        gpsOn = false;
        report(message, true);
        scheduleRender();
      },
    );
    gpsOn = started;
    report(
      started
        ? 'Waiting for device GPS…'
        : 'Geolocation is not available in this browser.',
      !started,
    );
    scheduleRender();
  });
  $('[data-tak-fix-center]').addEventListener(
    'click',
    guard(() => {
      const center = getMapCenter();
      if (!center) throw new Error('Map center is not on the globe.');
      if (gpsOn) {
        geolocation.stop();
        client.refreshPositionAvailability();
        gpsOn = false;
      }
      client.setFix({ ...center, source: 'USER' });
      return 'Position set to the map center (operator-set, not GPS).';
    }, 'Unable to set position.'),
  );
  $('[data-tak-sa]').addEventListener(
    'change',
    guard((event) => {
      client.setSaEnabled(event.target.checked);
      if (!event.target.checked) return 'Position broadcast off.';
      if (!client.fix())
        return 'Position broadcast armed; set a position to start sending.';
      return client.link().state === 'open'
        ? 'Sending position to the gateway every 10 s; peer delivery is not confirmed.'
        : 'Position shown locally; connect to share it.';
    }, 'Unable to change broadcast.'),
  );
  $('[data-tak-emergency]').addEventListener(
    'click',
    guard(() => {
      const raise = !client.emergencyActive();
      if (raise && !confirm('Raise a 911 alert to all connected TAK peers?'))
        return '';
      const result = client.setEmergency(raise);
      const where = result.sent
        ? 'sent to gateway; peer delivery unconfirmed'
        : 'local only (not connected)';
      return raise
        ? `911 alert raised: ${where}.`
        : `Alert cancelled: ${where}.`;
    }, 'Unable to change alert.'),
  );

  const markerForm = $('[data-tak-marker-form]');
  $('[data-tak-marker-center]').addEventListener('click', () => {
    const center = getMapCenter();
    if (!center) return report('Map center is not on the globe.', true);
    $('[data-tak-lat]').value = center.lat.toFixed(6);
    $('[data-tak-lon]').value = center.lon.toFixed(6);
  });
  markerForm.addEventListener(
    'submit',
    guard((event) => {
      event.preventDefault();
      const result = client.addMarker({
        callsign: $('[data-tak-callsign]').value,
        lat: $('[data-tak-lat]').value,
        lon: $('[data-tak-lon]').value,
        remarks: $('[data-tak-remarks]').value.trim() || undefined,
        broadcast: $('[data-tak-marker-broadcast]').checked,
      });
      markerForm.reset();
      $('[data-tak-marker-broadcast]').checked = false;
      overlay.focus(result.uid);
      return result.sent
        ? 'Marker sent to gateway; peer delivery is not confirmed.'
        : 'Marker added locally (not shared).';
    }, 'Invalid marker.'),
  );

  $('[data-tak-chat-form]').addEventListener(
    'submit',
    guard((event) => {
      event.preventDefault();
      const input = $('[data-tak-chat-input]');
      const result = client.sendChat(input.value);
      input.value = '';
      return result.sent
        ? ''
        : 'Message kept locally: not connected to the gateway.';
    }, 'Unable to send message.'),
  );

  $('[data-tak-clear]').addEventListener('click', () => {
    if (
      !confirm(
        'Clear all TAK contacts and chat from this page? Peers are not affected.',
      )
    )
      return;
    client.store.clear();
    clearRetainedPicture();
    report('Local TAK state cleared.');
  });

  $('[data-tak-import]').addEventListener(
    'click',
    guard(() => {
      const input = $('[data-tak-xml]');
      const summary = client.importXml(input.value);
      input.value = '';
      return importMessage(summary);
    }, 'Unable to import CoT.'),
  );
  const file = $('[data-tak-file]');
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    try {
      if (selected.size > MAX_COT_DOCUMENT_BYTES)
        throw new Error('File exceeds the 1 MiB import limit.');
      const text = await selected.text();
      if (destroyed) return;
      report(importMessage(client.importXml(text)));
    } catch (error) {
      report(error?.message || 'Unable to read CoT file.', true);
    } finally {
      file.value = '';
    }
  });

  const unsubscribe = client.subscribe(scheduleRender);
  fillIdentity();
  render();

  return Object.freeze({
    render: scheduleRender,
    clearPrivateInputs,
    destroy() {
      destroyed = true;
      connectAttempt?.abort();
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      geolocation.stop();
      client.refreshPositionAvailability();
      root.remove();
    },
  });
}

function importMessage({ contact, chat, deleted, ignored, rejected }) {
  const parts = [`Imported ${contact} contact${contact === 1 ? '' : 's'}`];
  if (chat) parts.push(`${chat} chat`);
  if (deleted) parts.push(`${deleted} deleted`);
  const skipped = ignored + rejected;
  return `${parts.join(', ')}${skipped ? ` (${skipped} skipped)` : ''}. Imported data stays on this page.`;
}
