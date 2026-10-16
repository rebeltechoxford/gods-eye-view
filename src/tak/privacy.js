// Per-viewer, page-memory disclosure policy. This remains protected after a
// clear/hide: the camera and authored scene may still reveal a TAK location.
const sessions = new WeakMap();
export const TAK_PRIVACY_MESSAGE =
  'TAK privacy protection is active. Authorize AI, sharing and recording in the TAK panel for this session first.';

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
      authorized: false,
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
export function authorizeTakDisclosure(viewer, authorized) {
  const value = session(viewer);
  if (!value || value.authorized === (authorized === true)) return;
  value.authorized = authorized === true;
  changed(value);
}
export function takPrivacyState(viewer) {
  const value = session(viewer);
  return {
    private: value?.private === true,
    authorized: value?.authorized === true,
  };
}
export function isTakPrivacyBlocked(viewer) {
  const value = session(viewer);
  return !!value?.private && !value.authorized;
}
export function takDisclosureTicket(viewer) {
  const value = session(viewer);
  return { viewer: viewer ?? currentViewer(), revision: value?.revision ?? 0 };
}
export function canDiscloseTakData(ticket) {
  return (
    !isTakPrivacyBlocked(ticket?.viewer) &&
    (!ticket || (session(ticket.viewer)?.revision ?? 0) === ticket.revision)
  );
}
export function subscribeTakPrivacy(viewer, listener) {
  const value = session(viewer);
  value?.listeners.add(listener);
  return () => value?.listeners.delete(listener);
}
