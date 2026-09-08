import { renderedForms } from '../../../scripts/public-corpus/lib/render-values';

describe('renderedForms', () => {
  it('renders a currency value at scales 1, 1e3 and 1e6 with thousands separators, never a trailing .0', () => {
    const forms = renderedForms(1_234_567_890, 'currency');

    expect(forms).toEqual([
      { text: '1,234,567,890', scale: 1 },
      { text: '1,234,568', scale: 1e3 },
      { text: '1,235', scale: 1e6 },
    ]);
    for (const form of forms) {
      expect(form.text).not.toMatch(/\.\d/);
    }
  });

  it('renders a negative currency value in parentheses, not with a minus sign', () => {
    const forms = renderedForms(-1234, 'currency');

    expect(forms[0]).toEqual({ text: '(1,234)', scale: 1 });
  });

  it('deduplicates identical renders across scales', () => {
    const forms = renderedForms(0, 'currency');

    expect(forms).toEqual([{ text: '0', scale: 1 }]);
  });

  it('renders a per-share value to exactly two decimal places at scale 1', () => {
    expect(renderedForms(0.8, 'per-share')).toEqual([{ text: '0.80', scale: 1 }]);
    expect(renderedForms(-0.15, 'per-share')).toEqual([{ text: '(0.15)', scale: 1 }]);
  });

  it('renders a count as a thousands-separated integer at scale 1', () => {
    expect(renderedForms(1234567, 'count')).toEqual([{ text: '1,234,567', scale: 1 }]);
  });

  it('renders an area as a thousands-separated integer at scale 1', () => {
    expect(renderedForms(987654, 'area')).toEqual([{ text: '987,654', scale: 1 }]);
  });
});
