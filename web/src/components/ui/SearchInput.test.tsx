import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SearchInput from './SearchInput';

describe('SearchInput', () => {
  it('exposes a search landmark', () => {
    render(<SearchInput label="Search" value="" onChange={() => {}} />);

    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('clears the value and returns focus to the input', () => {
    const onChange = vi.fn();
    render(<SearchInput label="Search" value="rent roll" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.getByLabelText('Search')).toHaveFocus();
  });

  it('clears onChange before onSearch, both with the empty value', () => {
    const onChange = vi.fn();
    const onSearch = vi.fn();
    render(
      <SearchInput label="Search" value="rent roll" onChange={onChange} onSearch={onSearch} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(onChange).toHaveBeenCalledWith('');
    expect(onSearch).toHaveBeenCalledWith('');
    expect(onChange.mock.invocationCallOrder[0]).toBeLessThan(onSearch.mock.invocationCallOrder[0]);
  });

  it('fires onSearch on Enter', () => {
    const onSearch = vi.fn();
    render(
      <SearchInput label="Search" value="rent roll" onChange={() => {}} onSearch={onSearch} />,
    );

    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Enter' });

    expect(onSearch).toHaveBeenCalledWith('rent roll');
  });

  it('hides the clear control while empty', () => {
    render(<SearchInput label="Search" value="" onChange={() => {}} />);

    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
  });
});
