import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SortableHeaderCell from './SortableHeaderCell';
import Table from './Table';

type Field = 'question' | 'created';

function renderHeaderRow(sort: Field, direction: 'asc' | 'desc', onSort: (field: Field) => void) {
  return render(
    <Table caption="Answers">
      <thead>
        <tr>
          <SortableHeaderCell
            field="question"
            label="Question"
            sort={sort}
            direction={direction}
            onSort={onSort}
          />
          <SortableHeaderCell
            field="created"
            label="Created"
            sort={sort}
            direction={direction}
            onSort={onSort}
          />
        </tr>
      </thead>
      <tbody />
    </Table>,
  );
}

describe('SortableHeaderCell', () => {
  it('sets aria-sort on the active column only, and states the direction in the accessible name', () => {
    renderHeaderRow('question', 'asc', () => {});

    const questionButton = screen.getByRole('button', {
      name: 'Sort by Question, sorted ascending',
    });
    const createdButton = screen.getByRole('button', { name: 'Sort by Created' });
    expect(questionButton.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(createdButton.closest('th')).not.toHaveAttribute('aria-sort');
  });

  it('calls onSort with the clicked field, leaving direction to the caller', () => {
    const onSort = vi.fn();
    renderHeaderRow('question', 'asc', onSort);

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Created' }));
    expect(onSort).toHaveBeenCalledWith('created');
  });

  it('reflects a toggled direction on re-activation of the already-active column', () => {
    const { rerender } = render(
      <Table caption="Answers">
        <thead>
          <tr>
            <SortableHeaderCell
              field="question"
              label="Question"
              sort="question"
              direction="asc"
              onSort={() => {}}
            />
          </tr>
        </thead>
        <tbody />
      </Table>,
    );
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending');

    rerender(
      <Table caption="Answers">
        <thead>
          <tr>
            <SortableHeaderCell
              field="question"
              label="Question"
              sort="question"
              direction="desc"
              onSort={() => {}}
            />
          </tr>
        </thead>
        <tbody />
      </Table>,
    );
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'descending');
  });
});
