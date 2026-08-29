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

  it('disables Previous on the first page and enables Next when more remain', () => {
    render(<Pager count={47} skip={0} pageSize={25} onSkipChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled();
  });

  it('enables Previous and disables Next on the last page', () => {
    render(<Pager count={47} skip={25} pageSize={25} onSkipChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
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
});
