import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Pager from './Pager';

describe('Pager', () => {
  it('renders the total count', () => {
    render(<Pager count={47} skip={0} pageSize={25} onSkipChange={vi.fn()} />);

    expect(screen.getByText('47 total')).toBeInTheDocument();
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
