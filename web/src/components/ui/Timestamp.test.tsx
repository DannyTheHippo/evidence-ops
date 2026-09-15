import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatAbsoluteTimestamp, formatRelativeTimestamp } from '../../lib/format-timestamp';
import Timestamp from './Timestamp';

describe('Timestamp', () => {
  it('renders a <time> element carrying the relative phrase and the parsed dateTime', () => {
    const iso = '2026-08-28T12:00:00.000Z';
    render(<Timestamp value={iso} />);

    const time = screen.getByText(formatRelativeTimestamp(iso));
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', iso);
  });

  it('exposes the absolute time without a title attribute', () => {
    const iso = '2026-08-28T12:00:00.000Z';
    render(<Timestamp value={iso} />);

    const time = screen.getByText(formatRelativeTimestamp(iso));
    expect(time).not.toHaveAttribute('title');
    expect(time).toHaveTextContent(formatAbsoluteTimestamp(iso));
  });

  it('renders the absolute value visibly in absolute mode', () => {
    const iso = '2026-08-28T12:00:00.000Z';
    render(<Timestamp value={iso} format="absolute" />);

    const time = screen.getByText(formatAbsoluteTimestamp(iso));
    expect(time.tagName).toBe('TIME');
    expect(time).not.toHaveAttribute('title');
  });

  it('renders both the relative and absolute values visibly in both mode', () => {
    const iso = '2026-08-28T12:00:00.000Z';
    render(<Timestamp value={iso} format="both" />);

    const time = screen.getByText(
      `${formatRelativeTimestamp(iso)} (${formatAbsoluteTimestamp(iso)})`,
    );
    expect(time.tagName).toBe('TIME');
  });

  it('omits the dateTime attribute for an unparseable value rather than emitting an invalid one', () => {
    render(<Timestamp value="not-a-date" />);

    const time = screen.getByText('—');
    expect(time.tagName).toBe('TIME');
    expect(time).not.toHaveAttribute('dateTime');
  });

  it('omits the dateTime attribute for an empty value', () => {
    render(<Timestamp value="" />);

    const time = screen.getByText('—');
    expect(time).not.toHaveAttribute('dateTime');
  });
});
