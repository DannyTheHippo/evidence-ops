import type { TextBlockLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

// Mirrors the 'txt'/'md' entries of SOURCE_KIND_TO_MIME_TYPE (documents.constant.ts). Not imported
// from there for the same reason docx.parser.ts doesn't: that map is the upload-time allowlist for
// a different feature, this is "what this parser class claims to handle" per the
// `DocumentParser.supports` contract — duplicated by design, not coupled across features.
const TEXT_MIME_TYPE = 'text/plain';
const MARKDOWN_MIME_TYPE = 'text/markdown';

// Bump whenever a change here could shift `blockIndex`/`headingPath` coordinates a stored
// citation already points at.
const EXTRACTOR_VERSION = 'text-block-1';

// A block is a heading only when it is exactly one line matching this pattern — `#{1,6}` followed
// by a required space, per ATX heading syntax. `#hashtag` (no space) never matches and falls
// through as ordinary body text.
const ATX_HEADING_PATTERN = /^(#{1,6}) (.*)$/;

/**
 * One parser for both plain text and Markdown: neither format has a paragraph-style concept to
 * key off of the way DOCX does, so both are split identically — on blank lines, with ATX headings
 * (present or not) driving the same running heading trail. Applying heading detection to `.txt`
 * too is deliberate: it is deterministic and harmless on files that contain no `#` lines, and
 * keeping one parser avoids two near-identical implementations drifting apart.
 */
export class TextParser implements DocumentParser {
  readonly supports = [TEXT_MIME_TYPE, MARKDOWN_MIME_TYPE];

  // eslint-disable-next-line @typescript-eslint/require-await -- matches the async `DocumentParser.parse` contract other parsers use for I/O; this one has none but keeps the same call shape.
  async parse(content: Buffer): Promise<ParsedDocument> {
    // Normalize CRLF to LF up front so blank-line and heading detection never depend on the
    // source file's line-ending style.
    const text = content.toString('utf-8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');

    const blocks: string[][] = [];
    let currentBlock: string[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) {
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
          currentBlock = [];
        }
      } else {
        currentBlock.push(line);
      }
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    const elements: ParsedElement[] = [];
    const headingTrail: string[] = [];

    // 0-based, matching `paragraphIndex` in docx.parser.ts.
    blocks.forEach((blockLines, blockIndex) => {
      // A heading is recognized only when the whole block is a single ATX-heading line — a
      // heading line immediately followed by body text with no blank line between them is not
      // split further and is kept as one ordinary body block, matching the blank-line-only
      // splitting rule above rather than inventing a second, line-level split.
      const headingMatch = blockLines.length === 1 ? ATX_HEADING_PATTERN.exec(blockLines[0]) : null;

      let blockText: string;
      if (headingMatch) {
        const level = headingMatch[1].length;
        // Mirrors docx.parser.ts: truncate the trail to the heading's own depth, then push — a
        // level-2 heading after a level-3 discards the level-3 (and deeper) entries.
        headingTrail.length = Math.min(headingTrail.length, level - 1);
        // The leading `#` markers are ATX syntax, not document content — the same way a docx
        // paragraph's "Heading2" style never appears inside the paragraph's own text.
        blockText = sanitizeEvidenceText(headingMatch[2]);
        headingTrail.push(blockText);
      } else {
        blockText = sanitizeEvidenceText(blockLines.join('\n'));
      }

      const headingPath = [...headingTrail];
      const locator: TextBlockLocator = {
        kind: 'text-block',
        blockIndex,
        headingPath,
        extractorVersion: EXTRACTOR_VERSION,
      };

      elements.push({ text: blockText, locator, headingPath });
    });

    return { elements, extractorVersion: EXTRACTOR_VERSION };
  }
}
