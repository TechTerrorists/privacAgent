// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionTraceList, type ActionTraceItem } from './ActionTraceList.js';

afterEach(cleanup);

const ITEMS: readonly ActionTraceItem[] = [
  { id: 'a1', label: 'Open dashboard', status: 'done', detail: 'element #12', meta: '120ms' },
  { id: 'a2', label: 'Summarise page', status: 'running' },
  { id: 'a3', label: 'Draft reply', status: 'pending' },
  { id: 'a4', label: 'Export snapshot', status: 'failed' },
  { id: 'a5', label: 'Send email', status: 'stopped' },
];

describe('ActionTraceList', () => {
  it('renders every item with a readable status', () => {
    render(<ActionTraceList items={ITEMS} ariaLabel="Recent agent actions" />);

    const list = screen.getByRole('list', { name: 'Recent agent actions' });
    expect(list.tagName).toBe('OL');
    expect(screen.getAllByTestId('pa-trace-item')).toHaveLength(ITEMS.length);
    expect(screen.getByText('Open dashboard')).toBeTruthy();
    expect(screen.getByText('element #12')).toBeTruthy();
    expect(screen.getByText('120ms')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Stopped')).toBeTruthy();
  });

  it('marks only the running item as current', () => {
    render(<ActionTraceList items={ITEMS} />);

    const current = screen
      .getAllByTestId('pa-trace-item')
      .filter((item) => item.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Summarise page');
  });

  it('falls back to an empty state when there are no items', () => {
    render(
      <ActionTraceList items={[]} emptyTitle="No actions yet" emptyDescription="Nothing ran." />
    );

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('No actions yet');
    expect(screen.getByRole('status').textContent).toContain('Nothing ran.');
  });

  it('activates an item from the keyboard when a handler is supplied', async () => {
    const onItemActivate = vi.fn();
    const user = userEvent.setup();
    render(<ActionTraceList items={ITEMS} onItemActivate={onItemActivate} />);

    const buttons = screen.getAllByTestId('pa-trace-activate');
    expect(buttons).toHaveLength(ITEMS.length);

    buttons[0]?.focus();
    expect(document.activeElement).toBe(buttons[0]);
    await user.keyboard('{Enter}');

    expect(onItemActivate).toHaveBeenCalledTimes(1);
    expect(onItemActivate.mock.calls[0]?.[0]).toEqual(ITEMS[0]);
  });

  it('renders extra per-item controls without breaking the list semantics', () => {
    render(
      <ActionTraceList
        items={ITEMS}
        renderItemAction={(item) => <span>{item.id.toUpperCase()}</span>}
      />
    );

    expect(screen.getByText('A3')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(ITEMS.length);
  });
});
