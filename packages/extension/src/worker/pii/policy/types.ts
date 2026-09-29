export interface UserMarkedRegion {
  readonly id: string;
  readonly selector: string;
}

export interface SitePolicy {
  readonly origin: string;
  readonly alwaysRedactSelectors: readonly string[];
  readonly neverSend: boolean;
  readonly userMarkedRegions: readonly UserMarkedRegion[];
}

export const MAX_SELECTOR_LENGTH = 300;
export const MAX_SELECTORS_PER_ORIGIN = 50;
export const MAX_USER_MARKED_REGIONS = 50;
export const MAX_MATCHED_ELEMENTS_PER_SELECTOR = 200;

export function emptyPolicy(origin: string): SitePolicy {
  return { origin, alwaysRedactSelectors: [], neverSend: false, userMarkedRegions: [] };
}
