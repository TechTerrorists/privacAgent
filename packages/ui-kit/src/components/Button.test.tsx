// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';

afterEach(cleanup);

describe('Button', () => {
  it('renders its label and fires onClick once per activation', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button label="Run agent" variant="primary" onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Run agent' });
    expect(button.getAttribute('data-variant')).toBe('primary');
    expect(button.getAttribute('type')).toBe('button');

    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('activates from the keyboard and takes focus', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button label="Run agent" onClick={onClick} />);

    await user.tab();
    const button = screen.getByRole('button', { name: 'Run agent' });
    expect(document.activeElement).toBe(button);

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button label="Run agent" onClick={onClick} disabled />);

    await user.click(screen.getByRole('button', { name: 'Run agent' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('reports busy state and blocks interaction while loading', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button label="Run agent" loading loadingLabel="Running…" onClick={onClick} />);

    const button = screen.getByRole('button', { name: 'Running…' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('exposes a submit type when asked', () => {
    render(<Button label="Save" type="submit" />);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('type')).toBe('submit');
  });
});
