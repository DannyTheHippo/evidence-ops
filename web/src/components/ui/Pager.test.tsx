import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Pager from './Pager';

describe('Pager', () => {
  it('renders the visible range for the first page', () => {
    render(<Pager count={143} skip={0} pageSize={20} onSkipChange={vi.fn()} />);

    expect(screen.getByText('1–20 of 143')).toBeInTheDocument();
  });

  it('renders the visible range for a middle page', () => {
    render(<Pager count={143} skip={40} pageSize={20} onSkipChange={vi.fn()} />);

    expect(screen.getByText('41–60 of 143')).toBeInTheDocument();
  });

  it('clamps the visible range to count on the last, partial page', () => {
    render(<Pager count={143} skip={140} pageSize={20} onSkipChange={vi.fn()} />);

    expect(screen.getByText('141–143 of 143')).toBeInTheDocument();
  });

  it('renders "0 of 0" rather than an implied range when count is zero', () => {
    render(<Pager count={0} skip={0} pageSize={20} onSkipChange={vi.fn()} />);

    expect(screen.getByText('0 of 0')).toBeInTheDocument();
  });

  it('names the pagination landmark', () => {
    render(<Pager count={47} skip={0} pageSize={25} onSkipChange={vi.fn()} />);

    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
  });

  it('marks Previous aria-disabled on the first page and Next aria-disabled on the last', () => {
    render(<Pager count={47} skip={0} pageSize={25} onSkipChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('marks Next aria-disabled on the last page and Previous aria-disabled false', () => {
    render(<Pager count={47} skip={25} pageSize={25} onSkipChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('calls onSkipChange with the next page on Next click', () => {
    const onSkipChange = vi.fn();
    render(<Pager count={47} skip={0} pageSize={25} onSkipChange={onSkipChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(onSkipChange).toHaveBeenCalledWith(25);
  });

  it('calls onSkipChange clamped to zero on Previous click', () => {
    const onSkipChange = vi.fn();
    render(<Pager count={47} skip={25} pageSize={25} onSkipChange={onSkipChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));

    expect(onSkipChange).toHaveBeenCalledWith(0);
  });

  it('keeps focus on Next at the last page', () => {
    const onSkipChange = vi.fn();
    render(<Pager count={47} skip={25} pageSize={25} onSkipChange={onSkipChange} />);

    const next = screen.getByRole('button', { name: 'Next' });
    next.focus();
    fireEvent.click(next);

    expect(onSkipChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(next);
  });

  it('changes the page size through the select', () => {
    const onPageSizeChange = vi.fn();
    render(
      <Pager
        count={143}
        skip={0}
        pageSize={20}
        onSkipChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), {
      target: { value: '50' },
    });

    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it('omits the page-size select when onPageSizeChange is absent', () => {
    render(<Pager count={143} skip={0} pageSize={20} onSkipChange={vi.fn()} />);

    expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
  });

  it('jumps to a page number', () => {
    const onSkipChange = vi.fn();
    render(<Pager count={143} skip={0} pageSize={20} onSkipChange={onSkipChange} showJump />);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Jump to page' }), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(onSkipChange).toHaveBeenCalledWith(60);
  });

  it('omits the jump control by default', () => {
    render(<Pager count={143} skip={0} pageSize={20} onSkipChange={vi.fn()} />);

    expect(screen.queryByRole('spinbutton', { name: 'Jump to page' })).not.toBeInTheDocument();
  });
});
