import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import QueueList from './QueueList';

interface Row {
  id: string;
  title: string;
}

const rows: Row[] = [
  { id: 'a', title: 'First' },
  { id: 'b', title: 'Second' },
  { id: 'c', title: 'Third' },
];

function renderList(selectedId: string | null, onSelect: (id: string) => void) {
  return render(
    <QueueList
      items={rows}
      selectedId={selectedId}
      onSelect={onSelect}
      ariaLabel="Rows"
      renderItem={(row) => ({
        identity: row.title,
        quantifier: 'q',
        age: 'a',
      })}
    />,
  );
}

function buttons() {
  return screen.getAllByRole('button');
}

describe('QueueList', () => {
  it('renders every item as a button carrying the three slots', () => {
    renderList('a', () => {});

    const [first] = buttons();
    expect(first).toHaveTextContent('First');
    expect(first).toHaveTextContent('q');
    expect(first).toHaveTextContent('a');
  });

  it('marks only the selected row aria-current, and gives it the sole tab stop', () => {
    renderList('b', () => {});

    const [first, second, third] = buttons();
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(first).not.toHaveAttribute('aria-current');
    expect(third).not.toHaveAttribute('aria-current');
    expect(second).toHaveAttribute('tabIndex', '0');
    expect(first).toHaveAttribute('tabIndex', '-1');
    expect(third).toHaveAttribute('tabIndex', '-1');
  });

  it('falls back to the first row as the tab stop when selectedId matches nothing on the page', () => {
    renderList('missing', () => {});

    const [first] = buttons();
    expect(first).toHaveAttribute('tabIndex', '0');
  });

  it('clicking a row selects it', () => {
    const onSelect = vi.fn();
    renderList('a', onSelect);

    fireEvent.click(buttons()[2]);

    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('ArrowDown moves focus to the next row and selects it', () => {
    const onSelect = vi.fn();
    renderList('a', onSelect);

    const [first, second] = buttons();
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });

    expect(second).toHaveFocus();
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('ArrowUp moves focus to the previous row and selects it', () => {
    const onSelect = vi.fn();
    renderList('b', onSelect);

    const [first, second] = buttons();
    second.focus();
    fireEvent.keyDown(second, { key: 'ArrowUp' });

    expect(first).toHaveFocus();
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('Home and End jump to the first and last row', () => {
    const onSelect = vi.fn();
    renderList('b', onSelect);

    const [first, second, third] = buttons();
    second.focus();
    fireEvent.keyDown(second, { key: 'Home' });
    expect(first).toHaveFocus();
    expect(onSelect).toHaveBeenCalledWith('a');

    third.focus();
    fireEvent.keyDown(third, { key: 'End' });
    expect(third).toHaveFocus();
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('names the row by the caller-supplied name instead of its slot text', () => {
    render(
      <QueueList
        items={rows}
        selectedId="a"
        onSelect={() => {}}
        ariaLabel="Rows"
        renderItem={(row) => ({
          identity: row.title,
          quantifier: 'q',
          age: 'a',
          name: `${row.title} concise name`,
        })}
      />,
    );

    expect(screen.getByRole('button', { name: 'First concise name' })).toBeInTheDocument();
  });

  it('keeps the concatenated slot text as the name when none is supplied', () => {
    renderList('a', () => {});

    const [first] = buttons();
    expect(first).not.toHaveAttribute('aria-label');
    expect(first).toHaveAccessibleName('First q a');
  });

  it('clamps at the last row instead of wrapping', () => {
    const onSelect = vi.fn();
    renderList('c', onSelect);

    const third = buttons()[2];
    third.focus();
    fireEvent.keyDown(third, { key: 'ArrowDown' });

    expect(third).toHaveFocus();
    expect(onSelect).toHaveBeenCalledWith('c');
  });
});
