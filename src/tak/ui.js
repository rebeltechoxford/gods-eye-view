import { MAX_COT_DOCUMENT_BYTES } from './protocol/cot.js';
import {
  ALL_CHAT_ROOMS,
  TAK_ROLES,
  TAK_TEAMS,
  TAK_TEAM_COLORS,
} from './protocol/builders.js';

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

const PANEL_HTML = `
<button class="tak-web-launcher" type="button" aria-expanded="false" aria-controls="tak-web-panel">TAK <span data-tak-badge>LOCAL</span></button>
<section id="tak-web-panel" class="tak-web-panel" hidden aria-label="TAK operations">
  <header class="tak-web-header">
    <strong>TAK OPERATIONS</strong>
    <span data-tak-link role="status" aria-live="polite">LOCAL</span>
  </header>
  <p class="tak-web-explainer" data-tak-gateway>Checking gateway…</p>
  <label class="tak-web-check"><input type="checkbox" data-tak-visible checked/> Show TAK layer on globe</label>
  <label class="tak-web-check"><input type="checkbox" data-tak-disclosure/> Allow AI, public links, scene exports and recording to include private TAK data and locations for this page session</label>
  <p class="tak-web-hint" data-tak-privacy>Privacy protection starts when TAK data is loaded.</p>

  <details class="tak-web-section" data-tak-section="identity">
    <summary>IDENTITY · <span data-tak-whoami></span></summary>
    <form data-tak-identity-form>
      <input data-tak-callsign-self maxlength="40" aria-label="Callsign" placeholder="Callsign" required/>
      <div class="tak-web-row">
        <select data-tak-team aria-label="Team"></select>
        <select data-tak-role aria-label="Role"></select>
      </div>
      <button type="submit">Save identity</button>
      <p class="tak-web-hint" data-tak-uid></p>
    </form>
  </details>

  <details class="tak-web-section" data-tak-section="network">
    <summary>NETWORK</summary>
    <form data-tak-connect-form>
      <input data-tak-token type="password" autocomplete="off" aria-label="Gateway token (if configured)" placeholder="Gateway token (if configured)"/>
      <div class="tak-web-row">
        <button type="submit" data-tak-connect>Connect</button>
        <button type="button" data-tak-disconnect>Disconnect</button>
      </div>
    </form>
    <p class="tak-web-hint" data-tak-uplinks></p>
  </details>

  <details class="tak-web-section" data-tak-section="position" open>
    <summary>MY POSITION</summary>
    <p class="tak-web-hint" data-tak-fix>No position set.</p>
    <div class="tak-web-row">
      <button type="button" data-tak-gps aria-pressed="false">Use device GPS</button>
      <button type="button" data-tak-fix-center>Set to map center</button>
    </div>
    <label class="tak-web-check"><input type="checkbox" data-tak-sa/> Broadcast my position (SA)</label>
    <button type="button" class="tak-web-alert" data-tak-emergency aria-pressed="false">RAISE 911 ALERT</button>
  </details>

  <details class="tak-web-section" data-tak-section="marker">
    <summary>DROP MARKER</summary>
    <form data-tak-marker-form>
      <input data-tak-callsign maxlength="120" aria-label="Marker label" placeholder="Label" required/>
      <div class="tak-web-row">
        <input data-tak-lat aria-label="Latitude" type="number" step="any" min="-90" max="90" placeholder="Latitude" required/>
        <input data-tak-lon aria-label="Longitude" type="number" step="any" min="-180" max="180" placeholder="Longitude" required/>
      </div>
      <input data-tak-remarks maxlength="500" aria-label="Remarks" placeholder="Remarks (optional)"/>
      <div class="tak-web-row">
        <button type="button" data-tak-marker-center>Map center</button>
        <button type="submit">Add marker</button>
      </div>
      <label class="tak-web-check"><input type="checkbox" data-tak-marker-broadcast checked/> Share with network</label>
    </form>
  </details>

  <div class="tak-web-roster-header">
    <strong data-tak-count>CONTACTS · 0</strong>
    <button type="button" data-tak-clear>Clear</button>
  </div>
  <input data-tak-filter aria-label="Filter contacts" placeholder="Filter callsign…"/>
  <div class="tak-web-roster" data-tak-list role="list"></div>

  <details class="tak-web-section" data-tak-section="chat">
    <summary>CHAT · ${ALL_CHAT_ROOMS.toUpperCase()} <span data-tak-chat-count></span></summary>
    <div class="tak-web-chat" data-tak-chat role="log" aria-live="polite"></div>
    <form data-tak-chat-form class="tak-web-row">
      <input data-tak-chat-input maxlength="1000" aria-label="Chat message" placeholder="Message" required/>
      <button type="submit">Send</button>
    </form>
  </details>

  <details class="tak-web-section" data-tak-section="import">
    <summary>IMPORT COT FILE</summary>
    <label class="tak-web-label" for="tak-web-file">Import .cot or .xml (up to 1 MiB, stays local)</label>
    <input id="tak-web-file" data-tak-file type="file" accept=".cot,.xml,text/xml,application/xml"/>
    <label class="tak-web-label" for="tak-web-xml">Or paste CoT XML</label>
    <textarea id="tak-web-xml" data-tak-xml rows="3" spellcheck="false" placeholder="&lt;event ...&gt;...&lt;/event&gt;"></textarea>
    <button data-tak-import type="button" class="tak-web-primary">Import XML to globe</button>
  </details>

  <div class="tak-web-status" data-tak-status role="status" aria-live="polite">Imported files and unshared markers never leave this page.</div>
  <footer data-tak-footer>NOT VERIFIED TACTICAL DATA · OPERATOR JUDGEMENT REQUIRED</footer>
</section>`;

function formatFix(fix) {
  if (!fix) return 'No position set.';
  return `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} · ${fix.source === 'GPS' ? 'device GPS' : 'operator set'}`;
}

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

function describeUplinks(link) {
  const g = link.gateway;
  if (!g || g.enabled === false) return '';
  const parts = [];
  parts.push(
    g.mesh
      ? `Mesh ${g.mesh.group}: ${g.mesh.state} (rx ${g.mesh.rx} / tx ${g.mesh.tx})`
      : 'Mesh: off',
  );
  parts.push(
    g.server
      ? `Server ${g.server.endpoint}: ${g.server.state}`
      : 'TAK Server: off',
  );
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
}) {
  const root = document.createElement('section');
  root.className = 'tak-web-root';
  root.setAttribute('aria-label', 'TAK web client');
  root.innerHTML = PANEL_HTML;
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
    $('[data-tak-uid]').textContent = `Device uid ${id.uid}`;
  }

  function renderRoster() {
    const filter = $('[data-tak-filter]').value.trim().toLowerCase();
    const contacts = client.store
      .list()
      .filter((c) => !filter || c.callsign.toLowerCase().includes(filter));
    $('[data-tak-count]').textContent = `CONTACTS · ${client.store.count()}`;
    const roster = $('[data-tak-list]');
    roster.replaceChildren();
    if (!contacts.length) {
      const empty = document.createElement('p');
      empty.className = 'tak-web-empty';
      empty.textContent = filter ? 'No contacts match.' : 'No contacts yet.';
      roster.append(empty);
      return;
    }
    for (const contact of contacts.slice(0, ROSTER_LIMIT)) {
      const row = document.createElement('div');
      row.className = 'tak-web-contact-row';
      row.setAttribute('role', 'listitem');
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.className = 'tak-web-contact';
      if (contact.emergency) entry.classList.add('tak-web-contact-emergency');
      entry.title = `Focus on ${contact.callsign}`;
      const title = document.createElement('strong');
      title.textContent = contact.callsign;
      const swatch = document.createElement('i');
      swatch.className = `tak-web-swatch tak-web-${contact.origin === 'self' ? 'self' : contact.affiliation}`;
      title.prepend(swatch);
      const meta = document.createElement('span');
      const stale = client.store.isStale(contact);
      meta.textContent = [
        `${contact.point.lat.toFixed(5)}, ${contact.point.lon.toFixed(5)}`,
        contact.origin.toUpperCase(),
        contact.event.detail.group?.name || null,
        stale ? 'STALE' : null,
        contact.emergency ? 'EMERGENCY' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      entry.append(title, meta);
      entry.addEventListener('click', () => overlay.focus(contact.uid));
      row.append(entry);
      if (contact.origin !== 'self') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'tak-web-remove';
        remove.textContent = '×';
        const shared = client.isOwnMarker(contact.uid);
        remove.title = shared
          ? `Delete ${contact.callsign} for everyone`
          : `Remove ${contact.callsign} from this page`;
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener(
          'click',
          guard(() => {
            const result = client.removeContact(contact.uid);
            return result.sent
              ? `Deletion sent to gateway for ${contact.callsign}; peer delivery is not confirmed.`
              : `Removed ${contact.callsign} locally.`;
          }, 'Unable to remove contact.'),
        );
        row.append(remove);
      }
      roster.append(row);
    }
    if (contacts.length > ROSTER_LIMIT) {
      const limited = document.createElement('p');
      limited.className = 'tak-web-empty';
      limited.textContent = `Showing first ${ROSTER_LIMIT} of ${contacts.length}.`;
      roster.append(limited);
    }
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

  function render() {
    frame = 0;
    if (destroyed) return;
    const link = client.link();
    if (link.lastReject && link.lastReject !== renderedReject) {
      renderedReject = link.lastReject;
      report(
        `Gateway rejected command: ${link.lastReject.reason.slice(0, 240)}`,
        true,
      );
    }
    const label = LINK_LABELS[link.state] || link.state.toUpperCase();
    $('[data-tak-badge]').textContent = label;
    $('[data-tak-link]').textContent =
      link.detail && link.state !== 'open'
        ? `${label} · ${link.detail}`
        : label;
    root.dataset.link = link.state;
    $('[data-tak-gateway]').textContent = describeGateway(link, gatewayInfo());
    $('[data-tak-uplinks]').textContent = describeUplinks(link);
    const id = client.identity();
    const whoami = $('[data-tak-whoami]');
    whoami.textContent = `${id.callsign} · ${id.team}`;
    whoami.style.borderBottomColor = TAK_TEAM_COLORS[id.team] || 'transparent';
    $('[data-tak-fix]').textContent = formatFix(client.fix());
    $('[data-tak-sa]').checked = client.saEnabled();
    const gps = $('[data-tak-gps]');
    gps.setAttribute('aria-pressed', String(gpsOn));
    gps.textContent = gpsOn ? 'Stop device GPS' : 'Use device GPS';
    const emergency = $('[data-tak-emergency]');
    emergency.setAttribute('aria-pressed', String(client.emergencyActive()));
    emergency.textContent = client.emergencyActive()
      ? 'CANCEL ALERT'
      : 'RAISE 911 ALERT';
    $('[data-tak-visible]').checked = overlay.isVisible();
    const policy = privacy.state();
    $('[data-tak-disclosure]').checked = policy.authorized;
    $('[data-tak-privacy]').textContent = policy.authorized
      ? 'Session authorization is ON. AI, links, exports and recording may reveal tactical data and locations.'
      : policy.private
        ? 'Protected: AI, sharing, scene capture/export and recording are blocked. Clearing or hiding contacts keeps locations protected until reload.'
        : 'Privacy protection starts when TAK data is loaded.';
    if (!panel.hidden) {
      renderRoster();
      renderChat();
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
  $('[data-tak-disclosure]').addEventListener('change', (event) => {
    privacy.authorize(event.target.checked);
    render();
  });
  $('[data-tak-filter]').addEventListener('input', () => renderRoster());

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

  $('[data-tak-gps]').addEventListener('click', () => {
    if (gpsOn) {
      geolocation.stop();
      gpsOn = false;
      report('Device GPS stopped. Last position kept.');
      scheduleRender();
      return;
    }
    const started = geolocation.start(
      (fix) => client.setFix({ ...fix, source: 'GPS' }),
      (message) => {
        geolocation.stop();
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
      $('[data-tak-marker-broadcast]').checked = true;
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
    destroy() {
      destroyed = true;
      connectAttempt?.abort();
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      geolocation.stop();
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
