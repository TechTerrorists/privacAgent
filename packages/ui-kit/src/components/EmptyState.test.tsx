// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState.js';

afterEach(cleanup);

describe('EmptyState', () => {
  it('announces as a status region with its title and description', () => {
    render(<EmptyState title="No saved tasks" description="Run a task to see it here." />);

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('No saved tasks');
    expect(status.textContent).toContain('Run a task to see it here.');
  });

  it('hides decorative icons from assistive technology', () => {
    const { container } = render(<EmptyState title="No saved tasks" icon="◎" />);

    const icon = container.querySelector('[aria-hidden="true"]');
    expect(icon?.textContent).toBe('◎');
  });

  it('renders interactive children and keeps them reachable by keyboard', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <EmptyState title="No saved tasks">
        <button type="button" onClick={onClick}>
          New task
        </button>
      </EmptyState>
    );

    const button = screen.getByRole('button', { name: 'New task' });
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
