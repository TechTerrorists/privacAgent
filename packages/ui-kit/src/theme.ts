export type ThemeName = 'light' | 'dark' | 'system';

export const THEME_ATTRIBUTE = 'data-pa-theme';

export const THEME_NAMES: readonly ThemeName[] = ['system', 'light', 'dark'];

export function isThemeName(value: unknown): value is ThemeName {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function applyTheme(target: HTMLElement, theme: ThemeName): void {
  if (theme === 'system') {
    target.removeAttribute(THEME_ATTRIBUTE);
    return;
  }
  target.setAttribute(THEME_ATTRIBUTE, theme);
}

export function readTheme(target: HTMLElement): ThemeName {
  const value = target.getAttribute(THEME_ATTRIBUTE);
  return isThemeName(value) ? value : 'system';
}
