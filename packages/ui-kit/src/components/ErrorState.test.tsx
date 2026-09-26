// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorState } from './ErrorState.js';

afterEach(cleanup);

describe('ErrorState', () => {
  it('announces as an alert with the failure message', () => {
    render(<ErrorState message="The agent did not respond." title="Agent request failed" />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Agent request failed');
    expect(alert.textContent).toContain('The agent did not respond.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('falls back to a generic title', () => {
    render(<ErrorState message="Boom" />);
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
  });

  it('fires retry and dismiss callbacks from the keyboard', async () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState message="Boom" onRetry={onRetry} onDismiss={onDismiss} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' }));
    await user.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss' }));
    await user.keyboard(' ');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('supports custom action labels and retry only', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState message="Boom" onRetry={onRetry} retryLabel="Reconnect" />);

    const retry = screen.getByRole('button', { name: 'Reconnect' });
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
