// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle.js';
import { applyTheme, isThemeName, readTheme, THEME_ATTRIBUTE } from '../theme.js';

afterEach(cleanup);

describe('applyTheme', () => {
  it('sets and clears the theme attribute without touching global state', () => {
    const root = document.createElement('div');

    applyTheme(root, 'dark');
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe('dark');
    expect(readTheme(root)).toBe('dark');

    applyTheme(root, 'light');
    expect(root.getAttribute(THEME_ATTRIBUTE)).toBe('light');

    applyTheme(root, 'system');
    expect(root.hasAttribute(THEME_ATTRIBUTE)).toBe(false);
    expect(readTheme(root)).toBe('system');
  });

  it('validates theme names', () => {
    expect(isThemeName('dark')).toBe(true);
    expect(isThemeName('neon')).toBe(false);
  });
});

describe('ThemeToggle', () => {
  it('is a labelled radio group reflecting the current value', () => {
    render(<ThemeToggle value="dark" onChange={() => {}} />);

    const group = screen.getByRole('group', { name: 'Theme' });
    expect(group).toBeTruthy();
    const dark = screen.getByRole('radio', { name: 'Dark' }) as HTMLInputElement;
    expect(dark.checked).toBe(true);
  });

  it('enters the group on the checked option and moves with the arrow keys', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemeToggle value="system" onChange={onChange} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'System' }));

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Light' }));
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('reports changes when an option is selected directly', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemeToggle value="system" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });
});
