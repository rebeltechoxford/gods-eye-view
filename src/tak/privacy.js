// Per-viewer, page-memory disclosure policy. This remains protected after a
// clear/hide: the camera and authored scene may still reveal a TAK location.
const sessions = new WeakMap();
export const TAK_PRIVACY_MESSAGE =
  'TAK privacy protection is active. Authorize this use in the TAK panel for this page session first.';
export const TAK_DISCLOSURE_SCOPES = Object.freeze([
  'ai',
  'sharing',
  'recording',
]);

function currentViewer() {
  return globalThis.window?.__godsEyeView?.viewer;
}
function session(viewer = currentViewer()) {
  if (!viewer || (typeof viewer !== 'object' && typeof viewer !== 'function'))
    return null;
  let value = sessions.get(viewer);
  if (!value) {
    value = {
      private: false,
      permissions: new Set(),
      revision: 0,
      listeners: new Set(),
    };
    sessions.set(viewer, value);
  }
  return value;
}
function changed(value) {
  value.revision++;
  for (const listener of value.listeners) {
    try {
      listener();
    } catch {
      /* One consumer cannot bypass another's privacy gate. */
    }
  }
}
export function markTakDataPrivate(viewer) {
  const value = session(viewer);
  if (!value || value.private) return;
  value.private = true;
  changed(value);
}
/** Omitted scope revokes/grants all; UI grants only a named use. Nothing persists. */
export function authorizeTakDisclosure(viewer, authorized, scope) {
  const value = session(viewer);
  const scopes = scope === undefined ? TAK_DISCLOSURE_SCOPES : [scope];
  if (!value || scopes.some((name) => !TAK_DISCLOSURE_SCOPES.includes(name)))
    return false;
  let updated = false;
  for (const name of scopes) {
    if (value.permissions.has(name) === (authorized === true)) continue;
    if (authorized === true) value.permissions.add(name);
    else value.permissions.delete(name);
    updated = true;
  }
  if (updated) changed(value);
  return true;
}
export function takPrivacyState(viewer) {
  const value = session(viewer);
  return {
    private: value?.private === true,
    authorized: TAK_DISCLOSURE_SCOPES.every((name) =>
      value?.permissions.has(name),
    ),
  };
}
export function takDisclosurePermissions(viewer) {
  const value = session(viewer);
  return Object.fromEntries(
    TAK_DISCLOSURE_SCOPES.map((name) => [
      name,
      value?.permissions.has(name) === true,
    ]),
  );
}
export function isTakPrivacyBlocked(viewer, scope) {
  const value = session(viewer);
  if (!value?.private) return false;
  // An unclassified caller needs every permission. Unknown scope fails closed.
  return scope === undefined
    ? TAK_DISCLOSURE_SCOPES.some((name) => !value.permissions.has(name))
    : !TAK_DISCLOSURE_SCOPES.includes(scope) || !value.permissions.has(scope);
}
export function takDisclosureTicket(viewer, scope) {
  const value = session(viewer);
  return Object.freeze({
    viewer: viewer ?? currentViewer(),
    scope,
    revision: value?.revision ?? 0,
  });
}
export function canDiscloseTakData(ticket) {
  return (
    !isTakPrivacyBlocked(ticket?.viewer, ticket?.scope) &&
    (!ticket || (session(ticket.viewer)?.revision ?? 0) === ticket.revision)
  );
}
export function subscribeTakPrivacy(viewer, listener) {
  const value = session(viewer);
  value?.listeners.add(listener);
  return () => value?.listeners.delete(listener);
}
