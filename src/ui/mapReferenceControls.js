import { t } from '../i18n/index.js';
import { referenceMap } from '../maps/referenceCatalog.js';

/** Extra curated sources share the existing controller selection owner. */
export function createMapReferenceControls({
  container,
  stacks,
  onSelect,
  bind,
}) {
  const references = stacks.filter((stack) => referenceMap(stack.id));
  const parent = container?.parentElement;
  if (!references.length || !parent) return null;
  const doc = container.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'map-reference-controls';
  const label = doc.createElement('label');
  label.textContent = t('More maps / charts');
  const select = doc.createElement('select');
  select.id = 'map-reference-select';
  select.setAttribute('aria-label', t('More maps and charts'));
  label.htmlFor = select.id;
  const placeholder = doc.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t('Choose a reference map or chart…');
  select.appendChild(placeholder);
  const groups = new Map();
  for (const stack of references) {
    const descriptor = referenceMap(stack.id);
    let group = groups.get(descriptor.family);
    if (!group) {
      group = doc.createElement('optgroup');
      group.label = t(descriptor.family);
      select.appendChild(group);
      groups.set(descriptor.family, group);
    }
    const option = doc.createElement('option');
    option.value = stack.id;
    option.textContent = t(descriptor.label);
    option.disabled = stack.available === false;
    group.appendChild(option);
  }
  const details = doc.createElement('div');
  details.className = 'map-reference-details';
  details.setAttribute('aria-live', 'polite');
  root.append(label, select, details);
  parent.appendChild(root);
  bind(select, 'change', () => {
    if (select.value) onSelect(select.value);
  });
  return {
    render(activeId) {
      const descriptor = referenceMap(activeId);
      select.value = descriptor ? activeId : '';
      details.replaceChildren();
      details.hidden = !descriptor;
      if (!descriptor) return;
      const text = doc.createElement('p');
      text.textContent = [
        t(descriptor.coverage),
        t(descriptor.lifecycle),
        descriptor.referenceOnly
          ? t(
              'Reference display only. Check current official charts and notices before navigation.',
            )
          : '',
        t('Credit: {credit}.', { credit: descriptor.credit }),
      ]
        .filter(Boolean)
        .join(' ');
      const terms = doc.createElement('a');
      terms.href = descriptor.termsUrl;
      terms.target = '_blank';
      terms.rel = 'noopener noreferrer';
      terms.textContent = t('Source information and terms');
      details.append(text, terms);
    },
    destroy() {
      root.remove();
    },
  };
}
