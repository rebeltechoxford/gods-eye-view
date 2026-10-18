/** Opt-in process-wide TLS handshake admission, independent of connected streams. */
export const DEVICE_DIAL_LIMITS = Object.freeze({
  concurrent: 2,
  pending: 32,
  handshakeMs: 15_000,
  jitterMs: 250,
});

export function createDeviceDialAdmission({ random = Math.random } = {}) {
  const active = new Set(),
    queue = [];
  let draining = false;
  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (active.size < DEVICE_DIAL_LIMITS.concurrent && queue.length) {
        const job = queue.shift();
        if (job.done) continue;
        active.add(job);
        job.release = () => {
          if (job.done) return;
          job.done = true;
          active.delete(job);
          drain();
        };
        try {
          job.start(job.release);
        } catch (error) {
          job.release();
          try {
            job.onError(error);
          } catch {
            /* one failed observer cannot stall the queue */
          }
        }
      }
    } finally {
      draining = false;
    }
  }
  return Object.freeze({
    /** Reserve before invoking start; cancellation/release is idempotent. */
    request(start, onError = () => {}) {
      if (typeof start !== 'function' || typeof onError !== 'function')
        throw new TypeError('Dial admission requires callbacks');
      if (active.size + queue.length >= DEVICE_DIAL_LIMITS.pending) return null;
      const job = { start, onError, done: false, release: null };
      queue.push(job);
      drain();
      return () => {
        if (job.done) return;
        if (job.release) job.release();
        else {
          job.done = true;
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          drain();
        }
      };
    },
    retryDelay(base, maximum) {
      const fraction = Math.max(0, Math.min(1, Number(random()) || 0));
      const extra = Math.min(
        DEVICE_DIAL_LIMITS.jitterMs,
        Math.floor(fraction * (DEVICE_DIAL_LIMITS.jitterMs + 1)),
      );
      return Math.min(maximum, base + extra);
    },
    status: () => ({ active: active.size, waiting: queue.length }),
  });
}

export const deviceDialAdmission = createDeviceDialAdmission();
