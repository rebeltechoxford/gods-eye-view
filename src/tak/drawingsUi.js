import './drawings.css';
import { createDrawingsWorkflow } from './drawingsWorkflow.js';
import { parseCoordinate } from './navigation.js';
import {
  ROUTE_METHODS,
  ROUTE_DIRECTIONS,
  ROUTE_TYPES,
  GEOMETRY_LIMITS,
} from './geometry.js';

const distance = (metres) =>
  metres < 1000 ? `${metres.toFixed(1)} m` : `${(metres / 1000).toFixed(3)} km`;
const rgb = (argb = -1) =>
  `#${(argb >>> 0).toString(16).padStart(8, '0').slice(2)}`;
const argb = (value, alpha = 255) =>
  (alpha << 24) | Number.parseInt(value.slice(1), 16) | 0;

/** Additive, private drawing editor. It does not claim camera drag/tap gestures. */
export function createDrawingsPanel({
  container,
  client,
  overlay,
  getMapCenter,
  focusTarget,
  markPrivate,
}) {
  const section = document.createElement('details');
  section.className = 'tak-web-section tak-drawings';
  section.dataset.takSection = 'drawings';
  section.innerHTML = `
    <summary>DRAWINGS / ROUTES</summary>
    <p class="tak-web-hint">Create lines, areas and ordered routes on the globe. Drafts and saved drawings stay in this page until shared or exported in a mission package.</p>
    <label class="tak-web-label" for="tak-drawing-saved">Session drawings</label>
    <select id="tak-drawing-saved" data-drawing-saved><option value="">Select a drawing</option></select>
    <div class="tak-web-row"><button type="button" data-drawing-edit>Edit mine</button><button type="button" data-drawing-copy>Copy selected</button><button type="button" data-drawing-focus-saved>Focus selected</button></div>
    <div class="tak-web-row"><select data-drawing-kind aria-label="New drawing kind"><option value="polyline">Line</option><option value="polygon">Area</option><option value="route">Route</option></select><button type="button" data-drawing-new>New drawing</button></div>
    <fieldset data-drawing-editor disabled>
      <legend data-drawing-heading>Start a drawing</legend>
      <label class="tak-web-label" for="tak-drawing-name">Drawing name</label><input id="tak-drawing-name" data-drawing-name maxlength="64" autocomplete="off">
      <label class="tak-web-label" for="tak-drawing-notes">Notes</label><textarea id="tak-drawing-notes" data-drawing-notes maxlength="256" rows="2"></textarea>
      <div class="tak-web-row"><label>Line color<input type="color" data-drawing-color value="#ffffff"></label><label>Width<input type="number" min="0.5" max="32" step="0.5" data-drawing-width value="3"></label><label>Area fill<input type="color" data-drawing-fill value="#ffffff"></label></div>
      <div data-drawing-route hidden class="tak-drawing-route-options"><label>Travel method<select data-drawing-method></select></label><label>Direction<select data-drawing-direction></select></label><label>Route type<select data-drawing-route-type></select></label></div>
      <form data-drawing-vertex-form autocomplete="off">
        <label class="tak-web-label" for="tak-drawing-format">Vertex format</label><select id="tak-drawing-format" data-drawing-format><option>DD</option><option>DMS</option><option>MGRS</option><option>UTM</option></select>
        <label class="tak-web-label" for="tak-drawing-coordinate">Latitude, longitude / grid reference</label><input id="tak-drawing-coordinate" data-drawing-coordinate maxlength="160" placeholder="38.88927, -77.05020" required spellcheck="false" autocapitalize="off">
        <label class="tak-web-label" for="tak-drawing-hae">HAE metres (optional, all vertices)</label><input id="tak-drawing-hae" data-drawing-hae type="number" min="-12000" max="1000000" step="any" placeholder="Blank: follow ground">
        <div data-drawing-waypoint hidden><label class="tak-web-label" for="tak-drawing-waypoint-name">Waypoint name</label><input id="tak-drawing-waypoint-name" data-drawing-waypoint-name maxlength="64"><select data-drawing-waypoint-type aria-label="Route point kind"><option value="b-m-p-w">Waypoint / checkpoint</option><option value="b-m-p-c">Control point</option></select></div>
        <div class="tak-web-row"><button type="submit" data-drawing-add>Add vertex</button><button type="button" data-drawing-center>Add map center</button></div>
        <button type="button" data-drawing-cancel-vertex hidden>Cancel vertex edit</button>
      </form>
      <ol data-drawing-vertices class="tak-drawing-vertices"></ol>
      <p data-drawing-measure class="tak-web-hint"></p>
      <p data-drawing-validation class="tak-web-hint"></p>
      <div class="tak-web-row"><button type="button" data-drawing-reverse>Reverse order</button><button type="button" data-drawing-focus>Focus draft</button></div>
      <label class="tak-web-check"><input type="checkbox" data-drawing-broadcast> Share this save with authorized TAK peers</label>
      <button type="button" data-drawing-save>Save drawing locally</button>
      <button type="button" data-drawing-copy-draft>Keep draft as a new copy</button>
    </fieldset>
    <button type="button" data-drawing-clear>Clear editor</button>
    <p class="tak-web-hint">Range is WGS84 surface distance; bearings are TRUE north. Route vertices describe the path you enter; no road routing, turn alerts or background guidance. Shared transport status is not a peer receipt.</p>
    <p data-drawing-status class="tak-web-status" role="status" aria-live="polite">Choose a drawing kind to begin.</p>`;
  container.append(section);
  const $ = (selector) => section.querySelector(selector);
  const events = new AbortController();
  const workflow = createDrawingsWorkflow({ client, markPrivate });
  let destroyed = false,
    editingVertex = null,
    savedSignature = '',
    lastConflict = false;
  for (const [selector, values] of [
    ['[data-drawing-method]', ROUTE_METHODS],
    ['[data-drawing-direction]', ROUTE_DIRECTIONS],
    ['[data-drawing-route-type]', ROUTE_TYPES],
  ])
    for (const value of values) $(selector).add(new Option(value, value));
  function report(text, error = false) {
    $('[data-drawing-status]').textContent = text;
    $('[data-drawing-status]').classList.toggle('tak-web-error', error);
  }
  function selected() {
    const uid = $('[data-drawing-saved]').value;
    if (!uid) throw new Error('Select a session drawing.');
    return uid;
  }
  function settings() {
    const current = workflow.state()?.draft;
    if (!current) return;
    workflow.settings({
      callsign: $('[data-drawing-name]').value,
      remarks: $('[data-drawing-notes]').value,
      style: {
        ...current.style,
        strokeColor: argb(
          $('[data-drawing-color]').value,
          current.style ? current.style.strokeColor >>> 24 : 255,
        ),
        fillColor: argb(
          $('[data-drawing-fill]').value,
          current.kind === 'polygon'
            ? current.style
              ? current.style.fillColor >>> 24
              : 51
            : 0,
        ),
        strokeWidth: Number($('[data-drawing-width]').value),
      },
      ...(current.kind === 'route'
        ? {
            route: {
              ...current.route,
              method: $('[data-drawing-method]').value,
              direction: $('[data-drawing-direction]').value,
              routeType: $('[data-drawing-route-type]').value,
            },
          }
        : {}),
    });
  }
  function cancelVertex() {
    editingVertex = null;
    $('[data-drawing-coordinate]').value = '';
    $('[data-drawing-hae]').value = '';
    $('[data-drawing-waypoint-name]').value = '';
    $('[data-drawing-add]').textContent = 'Add vertex';
    $('[data-drawing-center]').disabled = false;
    $('[data-drawing-cancel-vertex]').hidden = true;
  }
  function populate() {
    cancelVertex();
    const draft = workflow.state()?.draft;
    $('[data-drawing-name]').value = draft?.callsign || '';
    $('[data-drawing-notes]').value = draft?.remarks || '';
    $('[data-drawing-color]').value = rgb(draft?.style?.strokeColor);
    $('[data-drawing-fill]').value = rgb(draft?.style?.fillColor);
    $('[data-drawing-width]').value = draft?.style?.strokeWidth ?? 3;
    $('[data-drawing-method]').value = draft?.route?.method || ROUTE_METHODS[0];
    $('[data-drawing-direction]').value =
      draft?.route?.direction || ROUTE_DIRECTIONS[0];
    $('[data-drawing-route-type]').value =
      draft?.route?.routeType || ROUTE_TYPES[0];
    $('[data-drawing-broadcast]').checked = false;
  }
  function button(label, action, index, disabled = false) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.dataset.drawingAction = action;
    node.dataset.index = index;
    node.disabled = disabled;
    return node;
  }
  function renderDraft() {
    if (destroyed) return;
    const state = workflow.state(),
      draft = state?.draft;
    $('[data-drawing-editor]').disabled = !draft;
    $('[data-drawing-heading]').textContent = draft
      ? `${draft.uid ? 'Edit' : 'New'} ${draft.kind}`
      : 'Start a drawing';
    $('[data-drawing-route]').hidden = draft?.kind !== 'route';
    $('[data-drawing-waypoint]').hidden = draft?.kind !== 'route';
    const list = $('[data-drawing-vertices]');
    list.replaceChildren();
    for (const [index, point] of (draft?.vertices || []).entries()) {
      const item = document.createElement('li'),
        text = document.createElement('span'),
        actions = document.createElement('div');
      text.textContent = `${point.callsign || `Vertex ${index + 1}`} · ${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}${point.hae == null ? ' · ground' : ` · HAE ${point.hae} m`}`;
      actions.className = 'tak-drawing-vertex-actions';
      actions.append(
        button('Edit', 'edit', index),
        button('↑', 'up', index, index === 0),
        button('↓', 'down', index, index === draft.vertices.length - 1),
        button('Focus', 'focus', index),
        button('Remove', 'remove', index),
      );
      actions.children[1].ariaLabel = `Move vertex ${index + 1} up`;
      actions.children[2].ariaLabel = `Move vertex ${index + 1} down`;
      item.append(text, actions);
      list.append(item);
    }
    let valid = false;
    try {
      if (draft) {
        const geometry = workflow.preview();
        overlay.setDraftGeometry(geometry);
        const legs = workflow.legs();
        $('[data-drawing-measure]').textContent =
          `${legs.length} legs · ${distance(legs.reduce((sum, leg) => sum + leg.distanceM, 0))} total. ${legs.map((leg, index) => `${index + 1}: ${distance(leg.distanceM)}, ${leg.trueBearingDeg == null ? 'bearing undefined' : `${leg.trueBearingDeg.toFixed(1)}° TRUE`}`).join(' · ')}`;
        $('[data-drawing-validation]').textContent = state.conflict
          ? 'Source changed or disappeared. Reload or make a new copy before saving.'
          : `${geometry.vertices.length}/${GEOMETRY_LIMITS.vertices} vertices · ${geometry.vertices.every((point) => point.hae == null) ? 'follows ground' : 'ellipsoidal HAE heights'} · ready to save`;
        valid = !state.conflict;
      } else throw new Error('Start a drawing to add vertices.');
    } catch (error) {
      overlay.setDraftGeometry(null);
      $('[data-drawing-measure]').textContent = '';
      $('[data-drawing-validation]').textContent = error.message;
    }
    $('[data-drawing-save]').disabled = !valid;
    $('[data-drawing-focus]').disabled = !valid;
    $('[data-drawing-save]').textContent = $('[data-drawing-broadcast]').checked
      ? 'Save and submit to TAK'
      : 'Save drawing locally';
    lastConflict = !!state?.conflict;
  }
  function renderSaved() {
    if (destroyed) return;
    const contacts = client.store
      .list()
      .filter((contact) => contact.geometryResult?.status === 'ok');
    const signature = JSON.stringify(
      contacts.map((contact) => [
        contact.uid,
        contact.callsign,
        client.isOwnGeometry(contact.uid),
      ]),
    );
    if (signature !== savedSignature) {
      savedSignature = signature;
      const select = $('[data-drawing-saved]'),
        value = select.value;
      select.replaceChildren(new Option('Select a drawing', ''));
      for (const contact of contacts)
        select.add(
          new Option(
            `${contact.callsign} · ${contact.geometryResult.geometry.kind}${client.isOwnGeometry(contact.uid) ? ' · mine' : ''}`,
            contact.uid,
          ),
        );
      select.value = value;
    }
    const uid = $('[data-drawing-saved]').value;
    $('[data-drawing-edit]').disabled = !client.isOwnGeometry(uid);
    $('[data-drawing-copy]').disabled = !uid;
    $('[data-drawing-focus-saved]').disabled = !uid;
    if (!!workflow.state()?.conflict !== lastConflict) renderDraft();
  }
  function run(action, { draft = true } = {}) {
    try {
      action();
    } catch (error) {
      report(error.message || 'Drawing action failed.', true);
    }
    if (draft) renderDraft();
    renderSaved();
  }
  function on(selector, type, action) {
    $(selector).addEventListener(type, action, { signal: events.signal });
  }
  on('[data-drawing-new]', 'click', () =>
    run(() => {
      workflow.start($('[data-drawing-kind]').value);
      populate();
      report('New local draft. Add vertices by coordinate or map center.');
    }),
  );
  for (const [selector, copy] of [
    ['[data-drawing-edit]', false],
    ['[data-drawing-copy]', true],
  ])
    on(selector, 'click', () =>
      run(() => {
        workflow.load(selected(), { copy });
        populate();
        report(
          copy
            ? 'Copied into a new local draft.'
            : 'Loaded this session’s drawing for editing.',
        );
      }),
    );
  on('[data-drawing-focus-saved]', 'click', () =>
    run(() => overlay.focus(selected()), { draft: false }),
  );
  on('[data-drawing-saved]', 'change', renderSaved);
  for (const selector of [
    '[data-drawing-name]',
    '[data-drawing-notes]',
    '[data-drawing-color]',
    '[data-drawing-fill]',
    '[data-drawing-width]',
    '[data-drawing-method]',
    '[data-drawing-direction]',
    '[data-drawing-route-type]',
  ])
    on(selector, 'input', () => run(settings));
  section.addEventListener('input', markPrivate, { signal: events.signal });
  function pointFields(point) {
    return {
      ...point,
      hae: $('[data-drawing-hae]').value,
      ...(workflow.state()?.draft.kind === 'route'
        ? {
            callsign: $('[data-drawing-waypoint-name]').value,
            type: $('[data-drawing-waypoint-type]').value,
            relation: 'c',
          }
        : {}),
    };
  }
  on('[data-drawing-vertex-form]', 'submit', (event) => {
    event.preventDefault();
    run(() => {
      settings();
      const point = pointFields(
        parseCoordinate(
          $('[data-drawing-coordinate]').value,
          $('[data-drawing-format]').value,
        ),
      );
      if (editingVertex === null) workflow.add(point);
      else workflow.replace(editingVertex, point);
      cancelVertex();
      report('Draft vertex saved locally.');
    });
  });
  on('[data-drawing-center]', 'click', () =>
    run(() => {
      settings();
      const point = getMapCenter();
      if (!point) throw new Error('Point the map at the ground first.');
      workflow.add(pointFields(point));
      cancelVertex();
      report('Map center added to the draft.');
    }),
  );
  on('[data-drawing-cancel-vertex]', 'click', cancelVertex);
  on('[data-drawing-vertices]', 'click', (event) => {
    const button = event.target.closest('button[data-drawing-action]');
    if (!button) return;
    run(() => {
      const index = Number(button.dataset.index),
        action = button.dataset.drawingAction;
      const point = workflow.state()?.draft.vertices[index];
      if (!point) throw new Error('Vertex no longer exists.');
      if (action === 'edit') {
        editingVertex = index;
        $('[data-drawing-format]').value = 'DD';
        $('[data-drawing-coordinate]').value = `${point.lat}, ${point.lon}`;
        $('[data-drawing-hae]').value = point.hae ?? '';
        $('[data-drawing-waypoint-name]').value = point.callsign || '';
        $('[data-drawing-waypoint-type]').value = point.type || 'b-m-p-w';
        $('[data-drawing-add]').textContent = `Update vertex ${index + 1}`;
        $('[data-drawing-center]').disabled = true;
        $('[data-drawing-cancel-vertex]').hidden = false;
        $('[data-drawing-coordinate]').focus();
      } else if (action === 'focus') focusTarget(point);
      else {
        cancelVertex();
        if (action === 'remove') workflow.remove(index);
        else workflow.move(index, action === 'up' ? -1 : 1);
      }
    });
  });
  on('[data-drawing-reverse]', 'click', () =>
    run(() => {
      cancelVertex();
      workflow.reverse();
      report('Vertex order reversed. Save to apply the change.');
    }),
  );
  on('[data-drawing-focus]', 'click', () =>
    run(() => overlay.focusDraft(), { draft: false }),
  );
  on('[data-drawing-broadcast]', 'change', renderDraft);
  on('[data-drawing-save]', 'click', () =>
    run(() => {
      settings();
      const result = workflow.save({
        broadcast: $('[data-drawing-broadcast]').checked,
      });
      report(
        result.sent
          ? 'Saved and sent to the gateway. Check Network delivery status; this is not a peer receipt.'
          : 'Saved locally. No successful network submission.',
      );
      populate();
      renderSaved();
      $('[data-drawing-saved]').value = result.uid;
    }),
  );
  on('[data-drawing-copy-draft]', 'click', () =>
    run(() => {
      workflow.copyDraft();
      $('[data-drawing-broadcast]').checked = false;
      report('Draft is now a new local copy; the source is unchanged.');
    }),
  );
  function clearPrivateInputs() {
    workflow.clear();
    populate();
    overlay.setDraftGeometry(null);
    renderDraft();
    report('Editor cleared. Saved session drawings remain in the roster.');
  }
  on('[data-drawing-clear]', 'click', clearPrivateInputs);
  const unsubscribe = client.subscribe(renderSaved);
  renderDraft();
  renderSaved();
  return Object.freeze({
    clearPrivateInputs,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      events.abort();
      unsubscribe();
      workflow.destroy();
      overlay.setDraftGeometry(null);
      section.remove();
    },
  });
}
