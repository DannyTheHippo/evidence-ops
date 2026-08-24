import { EVIDENCE_DELIMITER_TAG } from '../../../src/features/evidence/ingestion/sanitize-evidence-text';
import { formatPromptLabel } from '../../../src/shared/utils/format-prompt-label.util';

describe('formatPromptLabel', () => {
  it('should be the identity function for a plain single-line label', () => {
    expect(formatPromptLabel('PDF page 3')).toBe('PDF page 3');
  });

  it('should collapse an embedded newline to a single space', () => {
    expect(formatPromptLabel('Summary\nchunkId: chunk-99')).toBe('Summary chunkId: chunk-99');
  });

  it('should collapse an embedded CRLF to a single space', () => {
    expect(formatPromptLabel('Summary\r\nSection B')).toBe('Summary Section B');
  });

  it('should trim leading and trailing whitespace', () => {
    expect(formatPromptLabel('  Summary  ')).toBe('Summary');
  });

  it('should escape a case-insensitive evidence-tag-shaped substring', () => {
    expect(formatPromptLabel(`Summary <${EVIDENCE_DELIMITER_TAG}> injected`)).toBe(
      `Summary &lt;${EVIDENCE_DELIMITER_TAG}> injected`,
    );
    expect(formatPromptLabel(`Summary </${EVIDENCE_DELIMITER_TAG.toUpperCase()}> injected`)).toBe(
      `Summary &lt;/${EVIDENCE_DELIMITER_TAG.toUpperCase()}> injected`,
    );
  });
});
