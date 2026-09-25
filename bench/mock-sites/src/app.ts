import { preferences, products, profile, scenarios } from './fixtures.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing fixture control: ${id}`);
  return node as T;
}

function setText(id: string, text: string): void {
  element(id).textContent = text;
}

function setupProfile(): void {
  const form = element<HTMLFormElement>('profile-form');
  const name = element<HTMLInputElement>('profile-name');
  const email = element<HTMLInputElement>('profile-email');
  const phone = element<HTMLInputElement>('profile-phone');
  const inputs = [name, email, phone];
  function reset(): void {
    for (const [key, value] of Object.entries(profile)) {
      const input = element<HTMLInputElement>(`profile-${key}`);
      input.value = value;
      input.setCustomValidity('');
      setText(`saved-${key}`, value);
    }
    setText('profile-status', scenarios.profile.initialStatus);
    setText('profile-error', '');
  }
  for (const input of inputs) {
    input.addEventListener('input', () => {
      name.setCustomValidity(name.value.trim() ? '' : 'Enter a name.');
      setText('profile-status', 'Unsaved changes.');
      setText('profile-error', '');
    });
  }
  form.addEventListener(
    'invalid',
    () => {
      setText(
        'profile-error',
        'Check the required name, valid email, and phone format. Nothing was saved.'
      );
    },
    true
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    for (const input of inputs) setText(input.id.replace('profile-', 'saved-'), input.value);
    setText('profile-status', 'Profile saved.');
    setText('profile-error', '');
  });
  element('profile-reset').addEventListener('click', reset);
  reset();
}

function setupSettings(): void {
  const notifications = element<HTMLInputElement>('notifications');
  const digest = element<HTMLSelectElement>('digest');
  const compact = element<HTMLInputElement>('density-compact');
  const comfortable = element<HTMLInputElement>('density-comfortable');
  const timezone = element<HTMLSelectElement>('timezone');
  const form = element<HTMLFormElement>('settings-form');
  const renderSaved = () => {
    setText('saved-notifications', notifications.checked ? 'On' : 'Off');
    setText('saved-digest', notifications.checked ? digest.value : 'Off');
    setText('saved-density', compact.checked ? 'compact' : 'comfortable');
    setText('saved-timezone', timezone.value);
  };
  form.addEventListener('change', () => {
    digest.disabled = !notifications.checked;
    setText('settings-status', 'Unapplied changes.');
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    renderSaved();
    setText('settings-status', 'Settings applied.');
  });
  function reset(): void {
    notifications.checked = preferences.notifications;
    digest.value = preferences.digest;
    digest.disabled = false;
    comfortable.checked = true;
    compact.checked = false;
    timezone.value = preferences.timezone;
    renderSaved();
    setText('settings-status', scenarios.settings.initialStatus);
  }
  element('settings-reset').addEventListener('click', reset);
  reset();
}

function setupSearch(): void {
  const query = element<HTMLInputElement>('search-query');
  const category = element<HTMLSelectElement>('category');
  const available = element<HTMLInputElement>('available');
  const list = element<HTMLUListElement>('results');
  function render(): void {
    const term = query.value.trim().toLowerCase();
    const matches = products.filter(
      (product) =>
        product.name.toLowerCase().includes(term) &&
        (category.value === 'all' || product.category === category.value) &&
        (!available.checked || product.available)
    );
    list.replaceChildren(
      ...matches.map((product) => {
        const item = document.createElement('li');
        item.dataset.productId = product.id;
        const heading = document.createElement('h2');
        heading.textContent = product.name;
        const detail = document.createElement('p');
        detail.textContent = `${product.category} · ${product.available ? 'Available' : 'Out of stock'}`;
        item.append(heading, detail);
        return item;
      })
    );
    setText('result-count', `${matches.length} ${matches.length === 1 ? 'result' : 'results'}`);
    element('empty-results').hidden = matches.length !== 0;
  }
  element('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    render();
  });
  query.addEventListener('input', render);
  category.addEventListener('change', render);
  available.addEventListener('change', render);
  element('search-reset').addEventListener('click', () => {
    query.value = scenarios.search.initial.query;
    category.value = scenarios.search.initial.category;
    available.checked = scenarios.search.initial.available;
    render();
  });
  render();
}

switch (document.body.dataset.scenario) {
  case 'profile':
    setupProfile();
    break;
  case 'settings':
    setupSettings();
    break;
  case 'search':
    setupSearch();
    break;
}
