import { toFunctionOutput } from '../tools/functions.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';
import { createGevActionRunner } from './gevActions.js';
import { createVoiceCommands } from './commands.js';
import { cameraPoseKey, createPointerTracker } from './pointerContext.js';
import { createPointerPicker } from './pointerPick.js';
import { createReferentRegistry } from './referents.js';
import {
  isTakPrivacyBlocked,
  subscribeTakPrivacy,
  takDisclosureTicket,
  canDiscloseTakData,
  TAK_PRIVACY_MESSAGE,
} from '../tak/privacy.js';
export * from './realtimeController.js';

const ACTION_NAMES = new Set(GEV_ACTION_SCHEMAS.map((schema) => schema.name));
const LOCAL_VIEW_ACTIONS = new Set([
  'set_visual_style',
  'set_map_stack',
  'set_layer_visibility',
  'stop_tracking',
  'clear_annotations',
  'annotate_map',
  'track_entity',
  'control_cockpit',
]);

/**
 * Run app actions through `runner` and every other tool the catalog has
 * through the catalog. `loadCatalog` resolves the catalog when first needed.
 */
export function withToolCatalog(runner, loadCatalog) {
  if (typeof loadCatalog !== 'function') return runner;
  const runGevTool = async function runGevTool(name, args, options = {}) {
    if (ACTION_NAMES.has(name)) return runner(name, args, options);
    const catalog = await loadCatalog();
    if (!catalog?.get(name)) return runner(name, args, options);
    const result = await catalog.call(name, args ?? {}, {
      signal: options.signal,
    });
    return toFunctionOutput(name, result);
  };
  runGevTool.resetConversation = (...args) =>
    runner.resetConversation?.(...args);
  runGevTool.dispose = (...args) => runner.dispose?.(...args);
  return runGevTool;
}

/** Compose the standalone action runner with the voice controls. */
export function initGevVoiceCommands(options) {
  const canvas = options.viewer?.scene?.canvas || null;
  const cameraKey = () => cameraPoseKey(options.viewer);
  // Point-and-ask: the tracker and referents are shared by the runner (which
  // resolves 'pointer' and referent:n) and the controls (which snapshot the
  // pointer at turn start and clear both when the session ends).
  const pointer = canvas
    ? createPointerTracker({
        element: canvas,
        cameraKey,
        pick: createPointerPicker({
          viewer: options.viewer,
          dataManager: options.dataManager,
        }),
      })
    : null;
  const referents = createReferentRegistry();
  // The controller exists only after the runner, so its hooks bind late.
  const deixis = { pointer, referents, cameraKey };
  const baseRunner = withToolCatalog(
    createGevActionRunner({ ...options, deixis }),
    options.toolCatalog,
  );
  const runner = async (name, args, callOptions = {}) => {
    if (callOptions.localOnly && LOCAL_VIEW_ACTIONS.has(name))
      return baseRunner(name, args, callOptions);
    if (isTakPrivacyBlocked(options.viewer))
      return { ok: false, error: TAK_PRIVACY_MESSAGE };
    const privacy = takDisclosureTicket(options.viewer);
    const result = await baseRunner(name, args, callOptions);
    return canDiscloseTakData(privacy)
      ? result
      : { ok: false, error: TAK_PRIVACY_MESSAGE };
  };
  runner.resetConversation = (...args) =>
    baseRunner.resetConversation?.(...args);
  runner.dispose = (...args) => baseRunner.dispose?.(...args);
  const commands = createVoiceCommands({
    ...options,
    pointer,
    referents,
    runner,
  });
  const removePrivacyListener = subscribeTakPrivacy(options.viewer, () => {
    if (!isTakPrivacyBlocked(options.viewer)) return;
    commands.stop();
    pointer?.clear();
    referents.clear();
  });
  deixis.imageFrame = () => commands.retainedImageFrame?.() || null;
  deixis.onPointerUsed = () => commands.announcePointer?.();
  commands.session?.signal?.addEventListener(
    'abort',
    () => {
      removePrivacyListener();
      pointer?.destroy();
    },
    { once: true },
  );
  return commands;
}
