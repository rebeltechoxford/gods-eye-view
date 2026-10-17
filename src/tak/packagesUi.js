import './packages.css';
import { readPackageFile } from './packagesFile.js';
import {
  PACKAGE_LIMITS,
  inspectMissionPackage,
  applyMissionPackage,
  createMissionPackage,
  missionPackageAttachment,
} from './packages.js';

/** Local, session-memory package controls mounted within the existing TAK panel. */
export function createMissionPackagePanel({
  container,
  client,
  markPrivate = () => {},
}) {
  if (!container) return { clearPrivateInputs() {}, destroy() {} };
  const root = document.createElement('details');
  root.className = 'tak-web-section tak-package-panel';
  root.dataset.takSection = 'packages';
  root.innerHTML = `
    <summary>Mission packages · local</summary>
    <p>Inspect a TAK ZIP, then import its contacts locally. Nothing is sent to the gateway. Attachments are download-only.</p>
    <label>Package ZIP / DP (32 MiB maximum)<input data-tak-package-file type="file" accept=".zip,.dp,application/zip"></label>
    <button data-tak-package-inspect type="button">Inspect package</button>
    <div data-tak-package-preview></div>
    <button data-tak-package-apply type="button" disabled>Import inspected contacts locally</button>
    <hr>
    <label>New package name<input data-tak-package-name maxlength="128" placeholder="Local mission package"></label>
    <label>Filter available contacts<input data-tak-package-filter maxlength="128" type="search" placeholder="Callsign or UID"></label>
    <p data-tak-package-count></p>
    <fieldset><legend>Choose contacts to export</legend><div data-tak-package-contacts></div></fieldset>
    <label>Add PNG, JPEG, PDF or TXT files (8 MiB each)<input data-tak-package-attachments type="file" multiple accept=".png,.jpg,.jpeg,.pdf,.txt"></label>
    <label class="tak-web-check"><input data-tak-package-authorize type="checkbox">Allow this selected package to leave the app as a download.</label>
    <button data-tak-package-export type="button">Export selected package</button>
    <button data-tak-package-clear type="button">Clear package files and selections</button>
    <p data-tak-package-status role="status" aria-live="polite">Local files stay in page memory until cleared or this session ends.</p>`;
  container.append(root);
  const query = (selector) =>
    root.querySelector(`[data-tak-package-${selector}]`);
  const controller = new AbortController(),
    urls = new Map(),
    rows = new Map(),
    selectedUids = new Set();
  let retainedBytes = 0;
  let operation = new AbortController(),
    previewEvents = new AbortController(),
    inspected = null,
    destroyed = false,
    busy = false;
  function report(message) {
    if (!destroyed) query('status').textContent = message;
  }
  function resetOperation() {
    operation.abort();
    operation = new AbortController();
  }
  function clearPrivateInputs() {
    resetOperation();
    previewEvents.abort();
    previewEvents = new AbortController();
    inspected = null;
    selectedUids.clear();
    busy = false;
    for (const input of root.querySelectorAll('input')) {
      if (input.type === 'checkbox') input.checked = false;
      else input.value = '';
    }
    query('preview').replaceChildren();
    query('apply').disabled = true;
    for (const [url, record] of urls) {
      clearTimeout(record.timer);
      URL.revokeObjectURL(url);
    }
    urls.clear();
    retainedBytes = 0;
    renderContacts(false);
    report('Package files and selections cleared.');
  }
  function save(bytes, name, signal) {
    signal.throwIfAborted();
    if (destroyed) return;
    if (
      urls.size >= 4 ||
      retainedBytes + bytes.length > PACKAGE_LIMITS.archiveBytes
    )
      throw new Error(
        'Download memory limit reached. Wait up to 30 seconds or clear package files before retrying.',
      );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: 'application/octet-stream' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    // A clicked download is permission for this one file only. It neither
    // enables screenshots/AI nor calls the network client's send methods.
    retainedBytes += bytes.length;
    const release = () => {
      const record = urls.get(url);
      if (!record) return;
      clearTimeout(record.timer);
      URL.revokeObjectURL(url);
      urls.delete(url);
      retainedBytes -= record.bytes;
    };
    urls.set(url, { bytes: bytes.length, timer: setTimeout(release, 30_000) });
    try {
      root.append(anchor);
      anchor.click();
    } catch (error) {
      release();
      throw error;
    } finally {
      anchor.remove();
    }
  }
  async function run(action) {
    if (busy || destroyed) return;
    busy = true;
    const signal = operation.signal;
    try {
      await action(signal);
    } catch (error) {
      if (!signal.aborted) report(error?.message || 'Package operation failed');
    } finally {
      if (!signal.aborted) busy = false;
    }
  }
  function renderContacts(checkSession = true) {
    if (destroyed) return;
    if (checkSession && client.link().sessionExpired) {
      clearPrivateInputs();
      return;
    }
    const contacts = client.store.list(),
      remaining = new Set(),
      existing = new Set(contacts.map((contact) => contact.uid));
    for (const uid of selectedUids) {
      if (existing.has(uid)) continue;
      selectedUids.delete(uid);
      query('authorize').checked = false;
    }
    const filter = query('filter').value.trim().toLowerCase();
    const matching = contacts.filter((contact) =>
      `${contact.callsign} ${contact.uid}`.toLowerCase().includes(filter),
    );
    const visible = matching.slice(0, 150);
    visible.forEach((contact, index) => {
      remaining.add(contact.uid);
      let row = rows.get(contact.uid);
      if (!row) {
        const label = document.createElement('label'),
          input = document.createElement('input'),
          span = document.createElement('span');
        label.className = 'tak-web-check';
        input.type = 'checkbox';
        input.dataset.takPackageUid = contact.uid;
        label.append(input, span);
        row = { label, input, span };
        rows.set(contact.uid, row);
        query('contacts').append(label);
      }
      const label = `${contact.callsign} · ${contact.uid}`;
      if (row.span.textContent !== label) row.span.textContent = label;
      row.input.checked = selectedUids.has(contact.uid);
      const parent = query('contacts');
      if (parent.children[index] !== row.label)
        parent.insertBefore(row.label, parent.children[index] ?? null);
    });
    for (const [uid, row] of rows) {
      if (remaining.has(uid)) continue;
      row.label.remove();
      rows.delete(uid);
    }
    const message = `Showing ${visible.length} of ${matching.length} matching (${contacts.length} total). ${selectedUids.size} selected, maximum 127. Use the filter to find more contacts.`;
    if (query('count').textContent !== message)
      query('count').textContent = message;
  }
  const on = (name, event, action) =>
    query(name).addEventListener(event, action, { signal: controller.signal });
  on('file', 'change', () => {
    clearPrivateInputsExceptFile();
    if (query('file').files.length) markPrivate();
  });
  function clearPrivateInputsExceptFile() {
    resetOperation();
    previewEvents.abort();
    previewEvents = new AbortController();
    inspected = null;
    busy = false;
    query('preview').replaceChildren();
    query('apply').disabled = true;
    query('authorize').checked = false;
    report('Press Inspect package to validate every entry before importing.');
  }
  on('attachments', 'change', () => {
    query('authorize').checked = false;
    if (query('attachments').files.length) markPrivate();
  });
  on('filter', 'input', () => renderContacts());
  on('contacts', 'change', (event) => {
    query('authorize').checked = false;
    const input = event.target,
      uid = input.dataset.takPackageUid;
    if (!uid) return;
    if (input.checked && selectedUids.size >= 127) {
      input.checked = false;
      report('At most 127 contents can be selected for one package.');
    } else if (input.checked) selectedUids.add(uid);
    else selectedUids.delete(uid);
    renderContacts();
  });
  on(
    'inspect',
    'click',
    () =>
      void run(async (signal) => {
        const file = query('file').files[0];
        if (!file || file.size > PACKAGE_LIMITS.archiveBytes)
          throw new Error('Choose one ZIP / DP of at most 32 MiB');
        markPrivate();
        report(
          'Validating archive, manifest, CoT, attachment types and hashes…',
        );
        const bytes = await readPackageFile(file, {
          limit: PACKAGE_LIMITS.archiveBytes,
          signal,
        });
        signal.throwIfAborted();
        const result = await inspectMissionPackage(bytes, { signal });
        signal.throwIfAborted();
        previewEvents.abort();
        previewEvents = new AbortController();
        inspected = result;
        const title = document.createElement('p'),
          hash = document.createElement('p'),
          list = document.createElement('ul');
        title.textContent = `${result.name} · ${result.contacts} contact(s), ${result.attachments} attachment(s)`;
        hash.className = 'tak-package-hash';
        hash.textContent = `SHA-256 ${result.sha256} (integrity identifier; sender identity is not verified)`;
        for (const entry of result.contents) {
          const item = document.createElement('li'),
            label = document.createElement('span');
          label.textContent = `${entry.path} · ${entry.bytes} bytes${entry.ignored ? ' · manifest ignore=true' : ''}`;
          item.append(label);
          if (entry.kind === 'attachment') {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.takPackageSave = entry.path;
            button.textContent = 'Save this attachment';
            button.addEventListener(
              'click',
              () => {
                if (inspected !== result || operation.signal.aborted) return;
                try {
                  const attachment = missionPackageAttachment(
                    result,
                    entry.path,
                  );
                  save(attachment.bytes, attachment.name, operation.signal);
                  report(
                    'Only the chosen attachment was offered for download.',
                  );
                } catch (error) {
                  report(error.message);
                }
              },
              { signal: previewEvents.signal },
            );
            item.append(button);
          }
          list.append(item);
        }
        query('preview').replaceChildren(title, hash, list);
        query('apply').disabled = !result.contacts;
        report(
          'Package fully validated. Import is local. Drawing/route details are retained CoT; only their position is rendered. Attachments are never opened automatically.',
        );
      }),
  );
  on('apply', 'click', () => {
    if (!inspected || busy || destroyed) return;
    try {
      markPrivate();
      const result = applyMissionPackage(inspected, client.store);
      report(
        `Imported ${result.contact} contact(s); ${result.ignored} older/unchanged. ${result.attachments} attachment(s) remain available for explicit download. Nothing was sent.`,
      );
    } catch (error) {
      report(error.message);
    }
  });
  on(
    'export',
    'click',
    () =>
      void run(async (signal) => {
        const authorized = query('authorize').checked;
        query('authorize').checked = false;
        if (!authorized)
          throw new Error(
            'Allow this selected package download first. This does not authorize other disclosures.',
          );
        const contacts = [...selectedUids].map((uid) => client.store.get(uid));
        const files = [...query('attachments').files];
        if (
          contacts.some((contact) => !contact) ||
          files.length + contacts.length >= PACKAGE_LIMITS.entries
        )
          throw new Error(
            'Selection changed or exceeds 127 contents. Select again.',
          );
        if (files.some((file) => file.size > PACKAGE_LIMITS.entryBytes))
          throw new Error('An attachment exceeds 8 MiB');
        markPrivate();
        const attachments = [];
        let total = 0;
        for (const file of files) {
          total += file.size;
          if (total > PACKAGE_LIMITS.expandedBytes)
            throw new Error('Attachments exceed the 32 MiB package budget');
          attachments.push({
            name: file.name,
            bytes: await readPackageFile(file, {
              limit: PACKAGE_LIMITS.entryBytes,
              signal,
            }),
          });
          signal.throwIfAborted();
        }
        const result = await createMissionPackage({
          name: query('name').value,
          contacts,
          attachments,
          signal,
        });
        signal.throwIfAborted();
        save(result.bytes, result.name, signal);
        report(
          `Selected package offered for download · SHA-256 ${result.sha256}. ATAK/iTAK acceptance has not been verified.`,
        );
      }),
  );
  on('clear', 'click', clearPrivateInputs);
  const unsubscribe = client.subscribe(renderContacts);
  renderContacts();
  return Object.freeze({
    clearPrivateInputs,
    destroy() {
      if (destroyed) return;
      clearPrivateInputs();
      destroyed = true;
      controller.abort();
      unsubscribe();
      rows.clear();
      root.remove();
    },
  });
}
