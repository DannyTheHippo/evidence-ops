import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatAbsoluteTimestamp, formatRelativeTimestamp } from '../../lib/format-timestamp';
import Timestamp from './Timestamp';

describe('Timestamp', () => {
  it('renders a <time> element whose title carries the absolute value', () => {
    const iso = '2026-08-28T12:00:00.000Z';
    render(<Timestamp value={iso} />);

    const time = screen.getByText(formatRelativeTimestamp(iso));
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', iso);
    expect(time).toHaveAttribute('title', formatAbsoluteTimestamp(iso));
  });

  it('omits the dateTime attribute for an unparseable value rather than emitting an invalid one', () => {
    render(<Timestamp value="not-a-date" />);

    const time = screen.getByText('—');
    expect(time.tagName).toBe('TIME');
    expect(time).not.toHaveAttribute('dateTime');
    expect(time).toHaveAttribute('title', '—');
  });

  it('omits the dateTime attribute for an empty value', () => {
    render(<Timestamp value="" />);

    const time = screen.getByText('—');
    expect(time).not.toHaveAttribute('dateTime');
  });
});
