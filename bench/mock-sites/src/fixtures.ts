/** B-08 synthetic ground truth. Local test data, never real personal information. */
export const profile = {
  name: 'Avery Example',
  email: 'avery.canary@example.test',
  phone: '+12025550147',
} as const;

export const preferences = {
  notifications: true,
  digest: 'daily',
  density: 'comfortable',
  timezone: 'Asia/Kolkata',
} as const;

export const products = [
  { id: 'p01', name: 'Cedar Notebook', category: 'stationery', available: true },
  { id: 'p02', name: 'Harbor Pen Set', category: 'stationery', available: false },
  { id: 'p03', name: 'Cedar Desk Lamp', category: 'home', available: true },
  { id: 'p04', name: 'Pebble Mug', category: 'home', available: false },
  { id: 'p05', name: 'Trail Backpack', category: 'travel', available: true },
  { id: 'p06', name: 'Cedar Travel Pouch', category: 'travel', available: false },
] as const;

/** DOM fixture IDs are test addresses, not B-05 element IDs or E-01 wire identifiers. */
export const scenarios = {
  profile: {
    path: '/profile',
    heading: 'Edit profile',
    controls: ['profile-name', 'profile-email', 'profile-phone', 'profile-save', 'profile-reset'],
    initial: profile,
    initialStatus: 'No changes saved.',
  },
  settings: {
    path: '/settings',
    heading: 'Workspace settings',
    controls: [
      'notifications',
      'digest',
      'density-comfortable',
      'density-compact',
      'timezone',
      'settings-apply',
      'settings-reset',
    ],
    initial: preferences,
    initialStatus: 'Using default settings.',
  },
  search: {
    path: '/search',
    heading: 'Search the catalog',
    controls: ['search-query', 'category', 'available', 'search-submit', 'search-reset'],
    initial: { query: '', category: 'all', available: false },
    initialResultIds: products.map((product) => product.id),
  },
} as const;

/** Locations and expected values for privacy consumers; these do not assert detector coverage. */
export const canaries = [
  {
    id: 'profile-name-canary',
    kind: 'person',
    value: profile.name,
    input: '#profile-name',
    saved: '#saved-name',
  },
  {
    id: 'profile-email-canary',
    kind: 'email',
    value: profile.email,
    input: '#profile-email',
    saved: '#saved-email',
  },
  {
    id: 'profile-phone-canary',
    kind: 'phone',
    value: profile.phone,
    input: '#profile-phone',
    saved: '#saved-phone',
  },
] as const;
