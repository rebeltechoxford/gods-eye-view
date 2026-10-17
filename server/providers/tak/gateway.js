import { createHash, randomUUID } from 'node:crypto';
import {
  SUBMISSION_ID,
  SUBMISSION_WINDOW_MS,
  summarizeSubmission,
} from '../../../src/tak/delivery.js';
import {
  createCotRouter,
  createRateLimiter,
} from '../../../src/tak/protocol/router.js';
import {
  ALL_CHAT_ROOMS,
  buildPing,
  normalizeIdentity,
} from '../../../src/tak/protocol/builders.js';
import {
  cotKind,
  parseCotEvent,
  serializeCotEvent,
} from '../../../src/tak/protocol/cot.js';
import {
  authorizeBrowserRequest,
  authorizeLocalRequest,
  createBrowserAccessPolicy,
  matchesToken,
} from './access.js';
import { createMeshLink } from './meshLink.js';
import { createServerLink } from './serverLink.js';
import { canonicalBrowserGeometry } from './browserGeometry.js';

export const TAK_WS_ROUTE = '/api/tak/ws';
export const TAK_STATUS_ROUTE = '/api/tak/status';
export const TAK_SESSION_ROUTE = '/api/tak/session';
export const TAK_WS_PROTOCOL = 'tak.v1';
export const TAK_TOKEN_PROTOCOL_PREFIX = 'tak.token.';
export const MAX_BROWSER_FRAME_BYTES = 64 * 1024;
export const MAX_BROWSER_BUFFER_BYTES = 512 * 1024;
export const MAX_BROWSERS = 16;
export const REPLAY_LIMIT = 2000;
export const REPLAY_BYTES_LIMIT = 8 * 1024 * 1024;
export const SERVER_PING_INTERVAL_MS = 30_000;
export const GATEWAY_SUBMISSION_LIMIT = 256;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_UID =
  /^GEV-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Each gateway instance accepts only its configured server-authenticated principal. */
function hasAuthenticatedSession(
  req,
  authenticateSession,
  principal = 'local-operator',
) {
  if (!req || typeof authenticateSession !== 'function') return false;
  try {
    return authenticateSession(req)?.principal === principal;
  } catch {
    return false;
  }
}

export function authorizeUpgrade(
  req,
  {
    token,
    principal = 'local-operator',
    multiOperator = false,
    storageScope,
    accessPolicy = createBrowserAccessPolicy(),
  },
  { authenticateSession } = {},
) {
  const local = authorizeBrowserRequest(req, accessPolicy);
  if (!local.ok) return local;
  if (!matchesToken(token, token))
    return { ok: false, status: 401, reason: 'token' };
  const offered = String(req.headers?.['sec-websocket-protocol'] || '')
    .split(',')
    .map((p) => p.trim());
  if (!offered.includes(TAK_WS_PROTOCOL))
    return { ok: false, status: 400, reason: 'protocol' };
  if (multiOperator) {
    const scopes = offered.filter((protocol) =>
      protocol.startsWith('tak.scope.'),
    );
    if (
      scopes.length !== 1 ||
      !/^[a-f0-9]{64}$/.test(storageScope || '') ||
      scopes[0] !== `tak.scope.${storageScope}`
    )
      return { ok: false, status: 401, reason: 'operator context required' };
  }
  const supplied = offered.find((p) => p.startsWith(TAK_TOKEN_PROTOCOL_PREFIX));
  if (accessPolicy.mode === 'private-https') {
    return hasAuthenticatedSession(req, authenticateSession, principal)
      ? { ok: true }
      : { ok: false, status: 401, reason: 'operator session required' };
  }
  if (
    !matchesToken(supplied?.slice(TAK_TOKEN_PROTOCOL_PREFIX.length), token) &&
    !hasAuthenticatedSession(req, authenticateSession, principal)
  )
    return { ok: false, status: 401, reason: 'token' };
  return { ok: true };
}

/** Directed rooms and receipts require separate recipient authorization. */
export function isBroadcastChat(event) {
  return (
    event.type === 'b-t-f' &&
    event.detail.chat?.chatroom === ALL_CHAT_ROOMS &&
    (!event.detail.chat.id || event.detail.chat.id === ALL_CHAT_ROOMS) &&
    (!event.detail.remarks?.to || event.detail.remarks.to === ALL_CHAT_ROOMS)
  );
}

export function gatewayPolicy({ bridge }, now = Date.now) {
  return ({ event, from, to }) => {
    if (event && (event.staleMs <= now() || event.timeMs > now() + 60_000))
      return false;
    if (event && cotKind(event.type) === 'chat' && !isBroadcastChat(event))
      return false;
    if (to.kind === 'browser') return to.authorized === true;
    if (from.kind === 'browser' || from.kind === 'local')
      return to.kind === 'mesh' || to.kind === 'server';
    return (
      !!bridge &&
      ((from.kind === 'mesh' && to.kind === 'server') ||
        (from.kind === 'server' && to.kind === 'mesh'))
    );
  };
}

export function createTakGateway({
  config,
  WebSocketServer,
  createMesh = createMeshLink,
  createServer = createServerLink,
  now = Date.now,
  log = console,
  setInterval: every = setInterval,
  clearInterval: stopEvery = clearInterval,
  authenticateSession,
}) {
  if (!config.enabled || !matchesToken(config.token, config.token))
    throw new Error('An enabled TAK gateway requires an operator token');
  const authenticated = (req) =>
    hasAuthenticatedSession(req, authenticateSession, config.principal);
  const replay = new Map();
  const browsers = new Map();
  const browserContexts = new WeakMap();
  const ownedMarkers = new Map(); // uid -> { owner: device uid, staleMs }
  const browserGeometryEvents = new WeakMap();
  const registeredIdentities = new Set();
  const networkUids = new Set();
  let replayBytes = 0;
  let browserSeq = 0;
  let closed = false;
  let statusTimer = null;
  const uplinks = [];
  const routedSubmission = new WeakMap();
  function submissionState(record) {
    const routes = Array.from(record.routes.values());
    const state = summarizeSubmission(routes);
    record.state = state;
    if (record.legacy) {
      if (state !== 'queued') record.browser.legacySubmissions.delete(record);
      return;
    }
    control(record.browser.ws, {
      op: 'submission',
      id: record.id,
      state,
      routes,
      ...(record.reason ? { reason: record.reason } : {}),
    });
  }
  function cancelRecord(record) {
    record.inactive = true;
    for (const link of uplinks) link.cancel?.(record);
  }
  function expireSubmissions(browser) {
    for (const record of browser.legacySubmissions)
      if (record.deadline <= now()) {
        cancelRecord(record);
        browser.legacySubmissions.delete(record);
      }
    for (const [id, record] of browser.submissions) {
      if (record.state === 'queued' && record.deadline <= now()) {
        cancelRecord(record);
        for (const route of record.routes.values())
          if (route.state === 'queued')
            Object.assign(route, {
              state: 'expired',
              reason: 'Fresh submission window expired',
            });
        submissionState(record);
      }
      if (record.state !== 'queued' && record.createdAt + 60_000 <= now())
        browser.submissions.delete(id);
    }
  }
  function addUplink(link) {
    uplinks.push(link);
    router.addLink({
      ...link,
      send(xml, event) {
        const record = routedSubmission.get(event);
        if (!record) return link.send(xml, event);
        const onState = (outcome) => {
          if (
            record.inactive ||
            (record.legacy
              ? !record.browser.legacySubmissions.has(record)
              : record.browser.submissions.get(record.id) !== record)
          )
            return;
          record.routes.set(link.id, {
            id: link.id,
            state: outcome.state,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          });
          submissionState(record);
        };
        let accepted = false;
        try {
          accepted =
            link.send(xml, event, {
              owner: record,
              onState,
              canWrite: () =>
                !record.inactive &&
                record.browser.ws.readyState === 1 &&
                (!record.browser.sessionBased ||
                  authenticated(record.browser.request)),
            }) !== false;
        } catch {
          /* correlated rejection below */
        }
        if (!accepted)
          onState({
            state: 'rejected',
            reason: 'Uplink refused this submission',
          });
        return accepted;
      },
    });
  }
  const router = createCotRouter({
    policy: gatewayPolicy(config, now),
    now,
    onAudit: (entry) => {
      if (entry.action === 'send-failed')
        log.warn?.('[tak-gateway] send failed', entry.link);
    },
  });
  function dropReplay(uid) {
    const prior = replay.get(uid);
    if (prior) replayBytes -= prior.bytes;
    replay.delete(uid);
  }
  function prune() {
    const t = now();
    for (const [uid, item] of replay) if (item.staleMs <= t) dropReplay(uid);
    for (const [uid, item] of ownedMarkers)
      if (item.staleMs <= t) ownedMarkers.delete(uid);
  }
  router.subscribe((event, { xml, from }) => {
    prune();
    if (
      (from?.kind === 'mesh' || from?.kind === 'server') &&
      !registeredIdentities.has(event.uid) &&
      !ownedMarkers.has(event.uid)
    ) {
      networkUids.add(event.uid);
      while (networkUids.size > 8192)
        networkUids.delete(networkUids.values().next().value);
    }
    const kind = cotKind(event.type);
    if (kind === 'delete') {
      const target = event.detail.links[0]?.uid;
      const prior = replay.get(target);
      if (prior && event.timeMs >= prior.timeMs) dropReplay(target);
      return;
    }
    if (event.type === 'b-a-o-can') {
      const prior = replay.get(event.uid);
      if (prior && event.timeMs >= prior.timeMs) dropReplay(event.uid);
      return;
    }
    if (
      !['sa', 'marker', 'alert', 'drawing'].includes(kind) ||
      event.staleMs <= now() ||
      event.timeMs > now() + 60_000
    )
      return;
    if (event.timeMs < (replay.get(event.uid)?.timeMs ?? -Infinity)) return;
    dropReplay(event.uid);
    const bytes = Buffer.byteLength(xml);
    replay.set(event.uid, {
      xml,
      timeMs: event.timeMs,
      staleMs: event.staleMs,
      bytes,
    });
    replayBytes += bytes;
    while (replay.size > REPLAY_LIMIT || replayBytes > REPLAY_BYTES_LIMIT)
      dropReplay(replay.keys().next().value);
  });
  function send(ws, payload) {
    if (closed || ws.readyState !== 1) return false;
    const context = browserContexts.get(ws);
    if (context?.sessionBased && !authenticated(context.request)) {
      ws.close(1008, 'session expired');
      return false;
    }
    if (
      ws.bufferedAmount + Buffer.byteLength(payload) >
      MAX_BROWSER_BUFFER_BYTES
    ) {
      ws.terminate();
      return false;
    }
    try {
      ws.send(payload, (error) => {
        if (error) ws.terminate();
      });
      return true;
    } catch {
      ws.terminate();
      return false;
    }
  }
  const control = (ws, message) => send(ws, JSON.stringify(message));
  function broadcastStatus() {
    statusTimer = null;
    for (const { ws, request } of browsers.values())
      control(ws, { op: 'status', status: status(request) });
  }
  function scheduleStatus() {
    if (!closed && !statusTimer) statusTimer = setTimeout(broadcastStatus, 250);
  }
  if (config.mesh) {
    const mesh = createMesh({
      config: config.mesh,
      onXml: (xml) => router.receiveXml(xml, 'mesh'),
      onStatus: scheduleStatus,
    });
    addUplink(mesh);
  }
  let pingTimer = null;
  if (config.server) {
    const server = createServer({
      config: config.server,
      onXml: (xml) => router.receiveXml(xml, 'server'),
      onStatus: scheduleStatus,
      now,
    });
    addUplink(server);
    const identity = normalizeIdentity({
      uid: `GEV-GATEWAY-${randomUUID()}`,
      callsign: config.callsign,
    });
    pingTimer = every(() => {
      const event = buildPing(identity, { nowMs: now() });
      server.send(serializeCotEvent(event), event);
    }, SERVER_PING_INTERVAL_MS);
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BROWSER_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(TAK_WS_PROTOCOL) ? TAK_WS_PROTOCOL : false,
  });

  function authorizeEvent(event, browser) {
    const identity = browser.identity;
    if (!identity) return 'Register your identity before sending CoT';
    if (config.role === 'observer')
      return 'This principal has receive-only TAK access';
    const t = now();
    if (
      event.staleMs <= t ||
      event.staleMs > t + 24 * 60 * 60 * 1000 ||
      event.timeMs > t + 60_000 ||
      event.timeMs < t - 5 * 60_000
    )
      return 'Event must be fresh and expire within 24 hours';
    if (event.access || event.qos || event.opex)
      return 'Unsupported access/routing metadata';
    const kind = cotKind(event.type);
    const parent = event.detail.links.find((link) => link.relation === 'p-p');
    if (kind === 'drawing') {
      let canonical;
      try {
        canonical = canonicalBrowserGeometry(event, identity);
      } catch (error) {
        return error.message || 'Invalid browser drawing';
      }
      if (
        networkUids.has(event.uid) ||
        (ownedMarkers.has(event.uid) &&
          ownedMarkers.get(event.uid).owner !== identity.uid)
      )
        return 'Drawing uid belongs to another source';
      if (event.timeMs < (ownedMarkers.get(event.uid)?.timeMs ?? -Infinity))
        return 'Drawing update is older than its accepted revision';
      if (!ownedMarkers.has(event.uid) && ownedMarkers.size >= REPLAY_LIMIT)
        return 'Owned drawing/marker limit reached';
      ownedMarkers.set(event.uid, {
        owner: identity.uid,
        staleMs: event.staleMs,
        timeMs: event.timeMs,
      });
      browserGeometryEvents.set(event, canonical);
      return null;
    }
    if (
      (event.detail.extras || []).some(
        (extra) =>
          !['archive', '__forcedelete'].includes(extra.name) ||
          Object.keys(extra.attrs || {}).length ||
          (extra.children || []).length ||
          extra.text ||
          (extra.name === '__forcedelete' && kind !== 'delete'),
      )
    )
      return 'Unsupported browser detail extension';
    if (
      (kind !== 'chat' && event.detail.chat) ||
      (kind !== 'alert' && event.detail.emergency)
    )
      return 'Unexpected browser detail';
    if (kind === 'delete') {
      const target = event.detail.links[0]?.uid;
      if (
        !UUID.test(event.uid) ||
        event.detail.links.length !== 1 ||
        ownedMarkers.get(target)?.owner !== identity.uid
      )
        return 'Only markers created by this identity may be deleted';
      if (event.timeMs < (ownedMarkers.get(target)?.timeMs ?? -Infinity))
        return 'Delete is older than the accepted object revision';
      ownedMarkers.delete(target);
      return null;
    }
    if (kind === 'chat') {
      const chat = event.detail.chat;
      if (
        !isBroadcastChat(event) ||
        parent?.uid !== identity.uid ||
        event.detail.links.length !== 1 ||
        !UUID.test(chat?.messageId || '') ||
        event.uid !==
          `GeoChat.${identity.uid}.${ALL_CHAT_ROOMS}.${chat.messageId}` ||
        chat.senderCallsign !== identity.callsign ||
        event.detail.remarks?.source !== `BAO.F.ATAK.${identity.uid}` ||
        chat.participants?.length !== 2 ||
        chat.participants[0] !== identity.uid ||
        chat.participants[1] !== ALL_CHAT_ROOMS
      )
        return 'Only identified All Chat Rooms messages are supported';
      return null;
    }
    if (kind === 'sa' && event.uid === identity.uid) {
      if (
        parent ||
        event.detail.callsign !== identity.callsign ||
        !/^a-[fa]-[A-Z](?:-[A-Za-z0-9]+)*$/.test(event.type)
      )
        return 'Self position identity mismatch';
      return null;
    }
    const markerPrefix = `GEV-MARKER-${identity.uid.replace(/^GEV-/, '')}-`;
    if (
      (kind === 'marker' || kind === 'sa') &&
      event.uid.startsWith(markerPrefix) &&
      UUID.test(event.uid.slice(markerPrefix.length)) &&
      parent?.uid === identity.uid &&
      event.detail.links.length === 1
    ) {
      if (
        networkUids.has(event.uid) ||
        (ownedMarkers.has(event.uid) &&
          ownedMarkers.get(event.uid).owner !== identity.uid)
      )
        return 'Marker uid belongs to another source';
      if (!ownedMarkers.has(event.uid) && ownedMarkers.size >= REPLAY_LIMIT)
        return 'Owned marker limit reached';
      ownedMarkers.set(event.uid, {
        owner: identity.uid,
        staleMs: event.staleMs,
        timeMs: event.timeMs,
      });
      return null;
    }
    if (
      kind === 'alert' &&
      ['b-a-o-tbl', 'b-a-o-pan', 'b-a-o-opn', 'b-a-o-can'].includes(
        event.type,
      ) &&
      event.uid === `${identity.uid}-9-1-1` &&
      parent?.uid === identity.uid &&
      event.detail.links.length === 1 &&
      event.detail.emergency &&
      event.detail.emergency.cancel === (event.type === 'b-a-o-can')
    )
      return null;
    return 'Unsupported or unowned browser event';
  }

  function attachBrowser(ws, request) {
    const id = `browser:${++browserSeq}`;
    const limiter = createRateLimiter({ rate: 20, burst: 60, now });
    const offered = String(request?.headers?.['sec-websocket-protocol'] || '')
      .split(',')
      .map((p) => p.trim());
    const tokenProtocol = offered.find((p) =>
      p.startsWith(TAK_TOKEN_PROTOCOL_PREFIX),
    );
    const browser = {
      ws,
      identity: null,
      alive: true,
      request,
      submissions: new Map(),
      legacySubmissions: new Set(),
      sessionBased:
        config.accessPolicy?.mode === 'private-https' ||
        (!!request &&
          !matchesToken(
            tokenProtocol?.slice(TAK_TOKEN_PROTOCOL_PREFIX.length),
            config.token,
          )),
    };
    browserContexts.set(ws, browser);
    let replayTimer = null;
    function receiveEvent(text, submissionId) {
      let record;
      if (submissionId) {
        expireSubmissions(browser);
        const digest = createHash('sha256').update(text).digest('hex');
        const prior = browser.submissions.get(submissionId);
        if (prior) {
          if (prior.digest !== digest) {
            ws.close(1008, 'submission id reused');
            return;
          }
          submissionState(prior);
          return;
        }
        record = {
          id: submissionId,
          digest,
          browser,
          state: 'queued',
          createdAt: now(),
          deadline: now() + SUBMISSION_WINDOW_MS,
          routes: new Map(),
          reason: '',
        };
        if (browser.submissions.size >= GATEWAY_SUBMISSION_LIMIT) {
          control(ws, {
            op: 'submission',
            id: submissionId,
            state: 'rejected',
            routes: [],
            reason: 'Submission history capacity reached; wait before sending',
          });
          return;
        }
        browser.submissions.set(submissionId, record);
      }
      const rejectEvent = (reason) => {
        if (record) {
          record.reason = String(reason).slice(0, 240);
          for (const route of record.routes.values())
            if (route.state === 'queued') route.state = 'rejected';
          submissionState(record);
        } else if (reason !== 'duplicate')
          control(ws, { op: 'reject', reason });
      };
      let event;
      try {
        event = parseCotEvent(text);
      } catch {
        rejectEvent('Invalid CoT event');
        return;
      }
      prune();
      const denied = authorizeEvent(event, browser);
      if (denied) {
        rejectEvent(denied);
        return;
      }
      // Browser sends rebuild only the authorized schema; parsed peer XML retains extensions.
      let sanitized;
      try {
        sanitized =
          browserGeometryEvents.get(event) ||
          parseCotEvent(
            serializeCotEvent({
              ...event,
              namespaces: undefined,
              detail: { ...event.detail },
            }),
          );
      } catch {
        rejectEvent('CoT normalization exceeds protocol bounds');
        return;
      }
      if (!record && uplinks.length) {
        if (browser.legacySubmissions.size >= GATEWAY_SUBMISSION_LIMIT) {
          rejectEvent('Unwritten legacy submission capacity reached');
          return;
        }
        record = {
          legacy: true,
          browser,
          state: 'queued',
          deadline: now() + SUBMISSION_WINDOW_MS,
          routes: new Map(),
        };
        browser.legacySubmissions.add(record);
      }
      if (record) {
        record.deadline = Math.min(record.deadline, event.staleMs);
        for (const link of uplinks)
          record.routes.set(link.id, { id: link.id, state: 'queued' });
        routedSubmission.set(sanitized, record);
      }
      const result = router.publishValidated(sanitized, id);
      routedSubmission.delete(sanitized);
      if (!result.ok) {
        if (record?.legacy) {
          cancelRecord(record);
          browser.legacySubmissions.delete(record);
          record = null;
        }
        rejectEvent(result.reason);
      } else if (record) {
        if (!record.routes.size)
          record.reason = 'No authorized TAK uplink configured';
        submissionState(record);
      }
    }
    const link = {
      id,
      kind: 'browser',
      authorized: false,
      limits: { rate: 20, burst: 60 },
      send: (xml) => send(ws, xml),
    };
    router.addLink(link);
    browsers.set(id, browser);
    control(ws, { op: 'hello', link: id, status: status(request) });
    const identityTimeout = setTimeout(() => {
      if (!browser.identity) ws.close(1008, 'identity required');
    }, 10_000);
    function replayContacts() {
      prune();
      const backlog = Array.from(replay.values());
      const deadline = Date.now() + 10_000;
      let cursor = 0;
      const drainReplay = () => {
        replayTimer = null;
        if (closed || ws.readyState !== 1) return;
        if (Date.now() > deadline) {
          ws.close(1008, 'replay timeout');
          return;
        }
        let batch = 0;
        while (
          cursor < backlog.length &&
          batch++ < 16 &&
          ws.bufferedAmount < MAX_BROWSER_BUFFER_BYTES / 2
        ) {
          const item = backlog[cursor++];
          if (item.staleMs > now() && !send(ws, item.xml)) return;
        }
        if (cursor < backlog.length) replayTimer = setTimeout(drainReplay, 5);
      };
      drainReplay();
    }
    ws.on('pong', () => {
      browser.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (browser.sessionBased && !authenticated(browser.request)) {
        ws.close(1008, 'session expired');
        return;
      }
      if (!limiter.take()) {
        ws.close(1008, 'rate limit');
        return;
      }
      if (isBinary) {
        control(ws, {
          op: 'reject',
          reason: 'binary frames are not supported',
        });
        return;
      }
      const text = data.toString('utf8');
      if (text.trimStart().startsWith('{')) {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          /* rejected below */
        }
        if (message?.op === 'identity') {
          const uid = message.uid;
          const callsign =
            typeof message.callsign === 'string' ? message.callsign.trim() : '';
          if (
            !DEVICE_UID.test(uid || '') ||
            !callsign ||
            callsign.length > 40 ||
            /[\u0000-\u001f\u007f]/.test(callsign) ||
            networkUids.has(uid) ||
            (browser.identity && browser.identity.uid !== uid) ||
            (!registeredIdentities.has(uid) && registeredIdentities.size >= 32)
          ) {
            control(ws, {
              op: 'reject',
              reason:
                'Identity invalid, already assigned, or changed; reconnect to update it',
            });
            return;
          }
          const firstIdentity = !browser.identity;
          registeredIdentities.add(uid);
          browser.identity = { uid, callsign };
          link.authorized = true;
          clearTimeout(identityTimeout);
          if (control(ws, { op: 'identity', uid }) && firstIdentity) {
            replayContacts();
          }
        } else if (
          message?.op === 'cot' &&
          typeof message.id === 'string' &&
          SUBMISSION_ID.test(message.id) &&
          typeof message.xml === 'string' &&
          Object.keys(message).length === 3
        ) {
          receiveEvent(message.xml, message.id);
        } else if (
          message?.op === 'cancel-submissions' &&
          Object.keys(message).length === 1
        ) {
          for (const record of browser.submissions.values())
            if (record.state === 'queued') {
              cancelRecord(record);
              for (const route of record.routes.values())
                if (route.state === 'queued')
                  Object.assign(route, {
                    state: 'rejected',
                    reason:
                      'Browser requested cancellation; peer receipt unconfirmed',
                  });
              record.reason =
                'Browser requested cancellation; peer receipt unconfirmed';
              submissionState(record);
            }
          for (const record of browser.legacySubmissions) cancelRecord(record);
          browser.legacySubmissions.clear();
        } else if (message?.op === 'status')
          control(ws, { op: 'status', status: status(request) });
        else control(ws, { op: 'reject', reason: 'unknown control message' });
        return;
      }
      receiveEvent(text);
    });
    ws.on('close', () => {
      for (const record of browser.submissions.values()) cancelRecord(record);
      for (const record of browser.legacySubmissions) cancelRecord(record);
      browser.submissions.clear();
      browser.legacySubmissions.clear();
      clearTimeout(identityTimeout);
      if (replayTimer) clearTimeout(replayTimer);
      router.removeLink(id);
      browsers.delete(id);
      scheduleStatus();
    });
    ws.on('error', () => {});
    scheduleStatus();
  }
  const heartbeat = every(() => {
    prune();
    for (const browser of browsers.values()) {
      expireSubmissions(browser);
      if (browser.sessionBased && !authenticated(browser.request)) {
        browser.ws.close(1008, 'session expired');
        continue;
      }
      if (!browser.alive) {
        browser.ws.terminate();
        continue;
      }
      browser.alive = false;
      if (browser.ws.readyState === 1) browser.ws.ping();
    }
  }, 30_000);

  function handleUpgrade(req, socket, head) {
    let path;
    try {
      path = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (path !== TAK_WS_ROUTE) return false;
    const reject = (code) => {
      socket.end(
        `HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    };
    if (
      closed ||
      browsers.size >=
        Math.min(MAX_BROWSERS, config.browserLimit || MAX_BROWSERS)
    ) {
      reject(503);
      return true;
    }
    const verdict = authorizeUpgrade(req, config, { authenticateSession });
    if (!verdict.ok) {
      reject(verdict.status);
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachBrowser(ws, req));
    return true;
  }
  function publicStatus(req) {
    const internal = config.accessPolicy?.mode === 'private-https';
    const sessionAuthenticated = authenticated(req);
    return {
      enabled: true,
      tokenRequired: true,
      localOnly: !internal,
      internalOnly: internal,
      ...(!config.multiOperator || sessionAuthenticated
        ? { principal: config.principal || 'local-operator' }
        : {}),
      ...(config.multiOperator ? { multiOperator: true } : {}),
      bootstrapAllowed: !internal && !!config.localBootstrap,
      ...(sessionAuthenticated
        ? {
            sessionAuthenticated: true,
            ...(config.multiOperator
              ? { role: config.role, storageScope: config.storageScope }
              : {}),
          }
        : {}),
    };
  }
  function status(req) {
    return {
      ...publicStatus(req),
      bridge: config.bridge,
      browsers: browsers.size,
      mesh: uplinks.find((l) => l.kind === 'mesh')?.status() || null,
      server: uplinks.find((l) => l.kind === 'server')?.status() || null,
      router: router.stats(),
      errors: config.errors,
      replayBytes,
      replay: replay.size,
    };
  }
  function handleHttpRequest(req, res) {
    let path;
    try {
      path = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return false;
    }
    if (path !== TAK_SESSION_ROUTE && path !== TAK_STATUS_ROUTE) return false;
    const session = path === TAK_SESSION_ROUTE;
    const verdict = session
      ? authorizeLocalRequest(req)
      : authorizeBrowserRequest(
          req,
          config.accessPolicy || createBrowserAccessPolicy(),
          { requireOrigin: false },
        );
    const respond = (code, value) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };
    if (!verdict.ok) {
      respond(verdict.status, { error: 'Local same-origin access required' });
      return true;
    }
    if (req.method !== (session ? 'POST' : 'GET')) {
      respond(405, { error: 'Method Not Allowed' });
      return true;
    }
    if (session) {
      if (
        config.accessPolicy?.mode === 'private-https' ||
        !config.localBootstrap ||
        req.headers['x-tak-session'] !== '1' ||
        closed
      )
        respond(403, { error: 'Local token bootstrap is disabled' });
      else respond(200, { token: config.token, principal: 'local-operator' });
    } else respond(200, publicStatus(req));
    return true;
  }
  return Object.freeze({
    handleUpgrade,
    handleHttpRequest,
    status,
    publicStatus,
    router,
    recheckSessions() {
      for (const browser of browsers.values()) {
        if (browser.sessionBased && !authenticated(browser.request))
          browser.ws.close(1008, 'session expired');
      }
    },
    close({ sessionExpired = false } = {}) {
      if (closed) return;
      closed = true;
      if (statusTimer) clearTimeout(statusTimer);
      if (pingTimer) stopEvery(pingTimer);
      stopEvery(heartbeat);
      for (const { ws } of browsers.values()) {
        if (sessionExpired) {
          ws.close(1008, 'session expired');
          const timeout = setTimeout(() => ws.terminate(), 1000);
          timeout.unref();
          ws.once('close', () => clearTimeout(timeout));
        } else ws.terminate();
      }
      browsers.clear();
      for (const link of uplinks) link.close();
      wss.close();
      router.destroy();
      replay.clear();
      ownedMarkers.clear();
      networkUids.clear();
      registeredIdentities.clear();
    },
  });
}
