import './navigation.css';
import {
  COORDINATE_FORMATS,
  formatCoordinate,
  rangeBearing,
} from './navigation.js';
import {
  createNavigationWorkflow,
  navigationOrigin,
} from './navigationWorkflow.js';

const EXAMPLES = Object.freeze({
  DD: '38.88927, -77.05020',
  DMS: '38°53\'21.37"N 77°03\'00.72"W',
  MGRS: '18S UJ 22185 06486',
  UTM: '18 N 322185.1 4306486.7',
  UPS: 'N 2000000 1444542.6',
});

/** An additive operator panel; no geocoding, persistence, GPS or network send. */
export function createNavigationPanel({
  container,
  client,
  getMapCenter,
  focusTarget,
  markPrivate,
  gpsActive = () => false,
  subscribeMapCenter = () => () => {},
  now = Date.now,
}) {
  if (!container)
    throw new Error('TAK navigation requires its operator panel.');
  const section = document.createElement('details');
  section.className = 'tak-web-section tak-navigation';
  section.dataset.takSection = 'navigation';
  section.innerHTML = `
    <summary>COORDINATES / NAVIGATION</summary>
    <p class="tak-web-hint">WGS84 datum. Range is ellipsoidal surface distance; bearing is initial TRUE north, not magnetic/grid north. No elevation or route guidance.</p>
    <form data-tak-nav-form autocomplete="off">
      <label class="tak-web-label" for="tak-nav-format">Input format</label>
      <select id="tak-nav-format" data-tak-nav-format aria-label="Coordinate format"><option>DD</option><option>DMS</option><option>MGRS</option><option>UTM</option><option>UPS</option></select>
      <label class="tak-web-label" for="tak-nav-input">Waypoint coordinate</label>
      <textarea id="tak-nav-input" data-tak-nav-input maxlength="160" rows="2" required spellcheck="false" autocapitalize="off" aria-describedby="tak-nav-example"></textarea>
      <p id="tak-nav-example" class="tak-web-hint" data-tak-nav-example></p>
      <button type="submit" data-tak-nav-validate>Validate coordinate</button>
    </form>
    <div class="tak-web-row"><button type="button" data-tak-nav-center>Use map center</button><button type="button" data-tak-nav-position>Use my position</button></div>
    <dl class="tak-navigation-readout" data-tak-nav-readout hidden></dl>
    <p class="tak-web-hint" data-tak-nav-resolution hidden></p>
    <label class="tak-web-label" for="tak-nav-origin">Measure from</label>
    <select id="tak-nav-origin" data-tak-nav-origin><option value="map">Map center (not GPS)</option><option value="position">My position</option></select>
    <p class="tak-web-hint" data-tak-nav-reference></p>
    <output class="tak-navigation-range" data-tak-nav-range>No validated waypoint.</output>
    <button type="button" data-tak-nav-focus disabled>Focus waypoint</button>
    <label class="tak-web-label" for="tak-nav-label">Local marker label</label>
    <input id="tak-nav-label" data-tak-nav-label maxlength="120" autocomplete="off" placeholder="Waypoint label"/>
    <button type="button" data-tak-nav-marker disabled>Add local waypoint marker</button>
    <button type="button" data-tak-nav-clear>Clear waypoint</button>
    <p class="tak-web-hint">Coordinates stay in this page. Local markers are unshared; this does not set or broadcast your position. MGRS/UTM covers 80°S…84°N; UPS covers the polar regions. UPS coordinates at either pole resolve longitude to 0° by convention.</p>
    <p class="tak-web-status" data-tak-nav-status role="status" aria-live="polite">Enter a waypoint or use the map center.</p>`;
  container.querySelector('[data-tak-section="marker"]')?.after(section);
  if (!section.isConnected) container.append(section);
  const $ = (selector) => section.querySelector(selector);
  const input = $('[data-tak-nav-input]');
  const format = $('[data-tak-nav-format]');
  const origin = $('[data-tak-nav-origin]');
  const readout = $('[data-tak-nav-readout]');
  const status = $('[data-tak-nav-status]');
  const workflow = createNavigationWorkflow({
    client,
    focusTarget,
    markPrivate,
  });
  const events = new AbortController();
  let destroyed = false;
  function report(text, error = false) {
    status.textContent = text;
    status.classList.toggle('tak-web-error', error);
  }
  function reference(kind = origin.value) {
    return navigationOrigin({
      kind,
      fix: client.fix(),
      mapCenter: kind === 'map' ? getMapCenter() : null,
      gpsActive: gpsActive(),
      foreground: !document.hidden,
      nowMs: now(),
    });
  }
  function render() {
    if (destroyed) return;
    const target = workflow.target();
    $('[data-tak-nav-focus]').disabled = !target;
    $('[data-tak-nav-marker]').disabled = !target;
    readout.hidden = !target;
    const resolution = $('[data-tak-nav-resolution]');
    resolution.hidden = !target;
    resolution.textContent = target?.cellSizeM
      ? `MGRS grid cell centre · ${target.cellSizeM} m square. More displayed digits do not improve input accuracy.`
      : 'Displayed precision is not measured location accuracy.';
    readout.replaceChildren();
    if (target)
      for (const name of COORDINATE_FORMATS) {
        const term = document.createElement('dt');
        term.textContent = name;
        const value = document.createElement('dd');
        try {
          value.textContent = formatCoordinate(target, name);
        } catch {
          value.textContent =
            name === 'UPS'
              ? 'Available at 84°N…90°N or 80°S…90°S.'
              : 'Unavailable outside 80°S…84°N; use UPS.';
        }
        readout.append(term, value);
      }
    try {
      const from = reference();
      $('[data-tak-nav-reference]').textContent = from.label;
      let text = 'No validated waypoint.';
      if (target && from.point) {
        const measurement = rangeBearing(from.point, target);
        text = `${measurement.distanceM < 1000 ? `${measurement.distanceM.toFixed(1)} m` : `${(measurement.distanceM / 1000).toFixed(3)} km`} · ${measurement.trueBearingDeg === null ? 'true bearing undefined at coincident points/poles' : `${measurement.trueBearingDeg.toFixed(1)}° TRUE`}`;
      } else if (target)
        text = 'Range/bearing unavailable until the selected origin is usable.';
      $('[data-tak-nav-range]').textContent = text;
    } catch (error) {
      $('[data-tak-nav-range]').textContent = error.message;
    }
  }
  function run(action) {
    try {
      action();
    } catch (error) {
      report(error?.message || 'Navigation action failed.', true);
    }
    render();
  }
  function example() {
    input.placeholder = EXAMPLES[format.value];
    $('[data-tak-nav-example]').textContent =
      `${EXAMPLES[format.value]}${format.value === 'UTM' ? ' · N/S means hemisphere, not MGRS latitude band.' : format.value === 'DMS' ? ' · Latitude N/S first, longitude E/W second.' : ''}`;
  }
  function on(selector, type, action) {
    $(selector).addEventListener(type, action, { signal: events.signal });
  }
  on('[data-tak-nav-input]', 'input', () =>
    run(() => {
      workflow.invalidate();
      report('Coordinate changed. Validate it before navigation.');
    }),
  );
  on('[data-tak-nav-label]', 'input', () => markPrivate());
  on('[data-tak-nav-format]', 'change', () =>
    run(() => {
      const target = workflow.target();
      example();
      if (target) {
        try {
          input.value = formatCoordinate(target, format.value);
        } catch (error) {
          workflow.invalidate();
          input.value = '';
          throw error;
        }
      } else if (input.value) {
        workflow.invalidate();
        report('Input format changed. Validate the coordinate.');
      }
    }),
  );
  on('[data-tak-nav-form]', 'submit', (event) => {
    event.preventDefault();
    run(() => {
      workflow.enter(input.value, format.value);
      report('Waypoint validated. No position broadcast or network sharing.');
    });
  });
  function usePoint(kind) {
    run(() => {
      const from = reference(kind);
      if (!from.point) throw new Error(from.label);
      input.value = workflow.fromPoint(from.point, format.value);
      report(`Waypoint copied from ${from.label}.`);
    });
  }
  on('[data-tak-nav-center]', 'click', () => usePoint('map'));
  on('[data-tak-nav-position]', 'click', () => usePoint('position'));
  on('[data-tak-nav-origin]', 'change', () => {
    if (workflow.target()) markPrivate();
    render();
  });
  on('[data-tak-nav-focus]', 'click', () =>
    run(() => {
      if (workflow.focus() === false)
        throw new Error('Camera navigation could not start.');
      report('Focused on the validated waypoint.');
    }),
  );
  on('[data-tak-nav-marker]', 'click', () =>
    run(() => {
      workflow.addMarker($('[data-tak-nav-label]').value);
      report('Local waypoint marker added. It has not been shared.');
    }),
  );
  function clearPrivateInputs() {
    workflow.clear();
    input.value = '';
    $('[data-tak-nav-label]').value = '';
    report('Waypoint cleared. Privacy protection remains active.');
    render();
  }
  on('[data-tak-nav-clear]', 'click', clearPrivateInputs);
  section.addEventListener('toggle', render, { signal: events.signal });
  document.addEventListener('visibilitychange', render, {
    signal: events.signal,
  });
  const unsubscribe = client.subscribe(render);
  const removeCamera = subscribeMapCenter(() => {
    if (section.open && origin.value === 'map') render();
  });
  const timer = setInterval(() => {
    if (section.open && origin.value === 'position') render();
  }, 1000);
  example();
  render();
  return Object.freeze({
    clearPrivateInputs,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      events.abort();
      clearInterval(timer);
      unsubscribe();
      removeCamera();
      workflow.destroy();
      section.remove();
    },
  });
}
