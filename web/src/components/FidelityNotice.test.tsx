import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FidelityNotice from './FidelityNotice';

describe('FidelityNotice', () => {
  it('names every fidelity reason alongside a caution badge', () => {
    render(
      <FidelityNotice
        reasons={[
          'Document has 3 page(s) with no extractable text; falling back to OCR-only extraction',
          'Header row on sheet "Summary" was ambiguous; column names were inferred',
        ]}
      />,
    );

    expect(screen.getByText('reduced fidelity').className).toContain('badge--possible');
    expect(
      screen.getByText(
        'Document has 3 page(s) with no extractable text; falling back to OCR-only extraction',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Header row on sheet "Summary" was ambiguous; column names were inferred'),
    ).toBeInTheDocument();
  });

  it('renders nothing when there are no known fidelity reasons', () => {
    const { container } = render(<FidelityNotice reasons={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});
