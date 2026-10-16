/** Install and foreground/network state only. No location or credentials stored. */
export function createMobileSession({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  navigatorRef = globalThis.navigator,
  registerWorker = import.meta.env?.PROD === true,
} = {}) {
  const listeners = new Set();
  let disposed = false;
  let installPrompt = null;
  let installed = false;
  let worker = 'inactive';
  const secure = windowRef?.isSecureContext === true;
  const standalone = () =>
    installed ||
    navigatorRef?.standalone === true ||
    windowRef?.matchMedia?.('(display-mode: standalone)')?.matches === true;
  function state() {
    const layoutHeight = windowRef?.innerHeight || 0;
    const visualHeight = windowRef?.visualViewport?.height || layoutHeight;
    return {
      online: navigatorRef?.onLine !== false,
      foreground: documentRef?.hidden !== true,
      secure,
      standalone: standalone(),
      installAvailable: !!installPrompt,
      worker,
      // visualViewport may still describe the previous desktop frame when the
      // window resize arrives. Never size controls beyond the current layout.
      viewportHeight:
        layoutHeight > 0 ? Math.min(layoutHeight, visualHeight) : visualHeight,
      keyboardInset: Math.max(
        0,
        layoutHeight -
          (visualHeight + (windowRef?.visualViewport?.offsetTop || 0)),
      ),
    };
  }
  function notify() {
    if (!disposed) for (const listener of listeners) listener();
  }
  function beforeInstall(event) {
    if (disposed || !secure) return;
    event.preventDefault();
    installPrompt = event;
    notify();
  }
  function appInstalled() {
    installed = true;
    installPrompt = null;
    notify();
  }
  windowRef?.addEventListener('beforeinstallprompt', beforeInstall);
  windowRef?.addEventListener('appinstalled', appInstalled);
  windowRef?.addEventListener('online', notify);
  windowRef?.addEventListener('offline', notify);
  windowRef?.addEventListener('resize', notify);
  documentRef?.addEventListener('visibilitychange', notify);
  windowRef?.visualViewport?.addEventListener('resize', notify);
  windowRef?.visualViewport?.addEventListener('scroll', notify);
  if (
    registerWorker &&
    secure &&
    navigatorRef?.serviceWorker &&
    windowRef?.top === windowRef?.self
  ) {
    worker = 'registering';
    Promise.resolve()
      .then(() => {
        if (!disposed)
          return navigatorRef.serviceWorker.register('/gev-sw.js', {
            scope: '/',
            updateViaCache: 'none',
          });
      })
      .then((registration) => {
        if (!disposed) {
          worker = registration ? 'registered' : 'inactive';
          notify();
        }
      })
      .catch(() => {
        if (!disposed) {
          worker = 'unavailable';
          notify();
        }
      });
  }
  return Object.freeze({
    state,
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async install() {
      if (disposed) return 'closed';
      if (standalone()) return 'installed';
      const prompt = installPrompt;
      installPrompt = null;
      notify();
      if (!prompt) return secure ? 'use-browser-menu' : 'https-required';
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (disposed) return 'closed';
      return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
    },
    destroy() {
      disposed = true;
      installPrompt = null;
      listeners.clear();
      windowRef?.removeEventListener('beforeinstallprompt', beforeInstall);
      windowRef?.removeEventListener('appinstalled', appInstalled);
      windowRef?.removeEventListener('online', notify);
      windowRef?.removeEventListener('offline', notify);
      windowRef?.removeEventListener('resize', notify);
      documentRef?.removeEventListener('visibilitychange', notify);
      windowRef?.visualViewport?.removeEventListener('resize', notify);
      windowRef?.visualViewport?.removeEventListener('scroll', notify);
    },
  });
}
