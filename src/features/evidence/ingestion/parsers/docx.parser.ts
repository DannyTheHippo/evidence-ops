import { HttpStatus } from '@nestjs/common';
import JSZip from 'jszip';
import { xml2js, type Element } from 'xml-js';
import { BaseException } from '../../../../shared/exceptions/base.exception';
import type { DocxParagraphLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { assertSafeArchive, HostileArchiveException } from './safe-zip';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

// Mirrors the 'docx' entry of MIME_TYPE_TO_SOURCE_KIND (documents.constant.ts). Not imported from
// there: that map is the upload-time allowlist for a different feature, this is "what this parser
// class claims to handle" per the `DocumentParser.supports` contract — duplicated by design, not
// coupled across features.
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Bump whenever a change here could shift `paragraphIndex`/`headingPath` coordinates a stored
// citation already points at.
const EXTRACTOR_VERSION = 'docx-ooxml-1';

const DOCTYPE_PATTERN = /<!DOCTYPE/i;
const HEADING_STYLE_PATTERN = /^Heading(\d+)$/;

export class MalformedDocxException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/** Depth-first, document-order walk collecting every `<w:p>` — including ones nested in tables. */
function collectParagraphs(element: Element, out: Element[]): void {
  for (const child of element.elements ?? []) {
    if (child.name === 'w:p') {
      out.push(child);
    }
    collectParagraphs(child, out);
  }
}

/** Concatenates the text nodes under an element, verbatim — no trimming, so a run whose `<w:t>`
 * carries `xml:space="preserve"` keeps the word-boundary space it exists to protect. */
function collectText(element: Element): string {
  let text = '';
  for (const child of element.elements ?? []) {
    if (child.type === 'text' && typeof child.text === 'string') {
      text += child.text;
    } else {
      text += collectText(child);
    }
  }
  return text;
}

function collectParagraphText(paragraph: Element): string {
  const runs: string[] = [];
  const visit = (element: Element): void => {
    for (const child of element.elements ?? []) {
      if (child.name === 'w:t') {
        runs.push(collectText(child));
      } else {
        visit(child);
      }
    }
  };
  visit(paragraph);
  return runs.join('');
}

function getParagraphStyle(paragraph: Element): string | undefined {
  const pPr = paragraph.elements?.find((el) => el.name === 'w:pPr');
  const pStyle = pPr?.elements?.find((el) => el.name === 'w:pStyle');
  const value = pStyle?.attributes?.['w:val'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads `word/document.xml` directly rather than rendering through `mammoth`: a renderer exposes
 * no stable paragraph ordinal or machine-readable heading path, and `DocxParagraphLocator` needs
 * exactly those to make a citation resolvable back to an exact paragraph.
 */
export class DocxParser implements DocumentParser {
  readonly supports = [DOCX_MIME_TYPE];

  async parse(content: Buffer): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(content);
    } catch (error) {
      throw new MalformedDocxException('Could not open the file as a zip archive', error);
    }
    assertSafeArchive(zip);

    const documentEntry = zip.file('word/document.xml');
    if (!documentEntry) {
      throw new MalformedDocxException('Archive is missing word/document.xml');
    }
    const xml = await documentEntry.async('text');

    // Reject outright rather than parse-and-ignore: even without external-entity resolution, a
    // DOCTYPE's internal subset can still define entities that expand at parse time (the
    // "billion laughs" pattern), so refusing any DOCTYPE at all is the only fail-closed option.
    if (DOCTYPE_PATTERN.test(xml)) {
      throw new HostileArchiveException('word/document.xml declares a DOCTYPE');
    }

    let root: Element;
    try {
      root = xml2js(xml, {
        compact: false,
        trim: false,
        ignoreDeclaration: true,
        ignoreInstruction: true,
        ignoreComment: true,
      }) as Element;
    } catch (error) {
      throw new MalformedDocxException('word/document.xml is not well-formed XML', error);
    }

    const paragraphs: Element[] = [];
    collectParagraphs(root, paragraphs);

    const elements: ParsedElement[] = [];
    const headingTrail: string[] = [];

    paragraphs.forEach((paragraph, paragraphIndex) => {
      const text = collectParagraphText(paragraph);
      const style = getParagraphStyle(paragraph);
      const headingLevel = style ? HEADING_STYLE_PATTERN.exec(style) : null;

      if (headingLevel) {
        const level = Number(headingLevel[1]);
        headingTrail.length = Math.min(headingTrail.length, level - 1);
        headingTrail.push(sanitizeEvidenceText(text));
      }

      const headingPath = [...headingTrail];
      const locator: DocxParagraphLocator = {
        kind: 'docx-paragraph',
        paragraphIndex,
        headingPath,
        extractorVersion: EXTRACTOR_VERSION,
      };

      elements.push({
        text: sanitizeEvidenceText(text),
        locator,
        headingPath,
      });
    });

    return { elements, extractorVersion: EXTRACTOR_VERSION };
  }
}
