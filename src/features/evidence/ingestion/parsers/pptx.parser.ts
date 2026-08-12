import { xml2js, type Element } from 'xml-js';
import JSZip from 'jszip';
import type { PptxSlideLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { MalformedPptxException } from '../exceptions/ingestion.exception';
import { assertSafeArchive, HostileArchiveException } from './safe-zip';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

// Mirrors the 'pptx' entry of MIME_TYPE_TO_SOURCE_KIND (documents.constant.ts). Not imported from
// there: that map is the upload-time allowlist for a different feature, this is "what this parser
// class claims to handle" per the `DocumentParser.supports` contract — duplicated by design, not
// coupled across features.
const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Bump whenever a change here could shift the `slide` coordinate a stored citation already
// points at.
const EXTRACTOR_VERSION = 'pptx-ooxml-1';

const DOCTYPE_PATTERN = /<!DOCTYPE/i;

/** Depth-first search for the first descendant (or self) element with the given tag name. */
function findFirst(element: Element, name: string): Element | undefined {
  for (const child of element.elements ?? []) {
    if (child.name === name) {
      return child;
    }
    const found = findFirst(child, name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Concatenates the text nodes under an element, verbatim — no trimming, so a run whose `<a:t>`
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
      if (child.name === 'a:t') {
        runs.push(collectText(child));
      } else {
        visit(child);
      }
    }
  };
  visit(paragraph);
  return runs.join('');
}

/**
 * Every `<a:t>` run in document order, joined into one string per slide: runs within a paragraph
 * concatenate directly (a run boundary is a formatting break, not a word break), paragraphs join
 * with a newline. This walk does not special-case `<a:tbl>` — a table cell's text lives inside
 * its own `<a:txBody>`/`<a:p>`/`<a:t>` nesting exactly like a text box's, so table text is
 * collected for free without any table-specific traversal.
 */
function collectSlideText(spTree: Element): string {
  const paragraphs: string[] = [];
  const visit = (element: Element): void => {
    for (const child of element.elements ?? []) {
      if (child.name === 'a:p') {
        paragraphs.push(collectParagraphText(child));
      } else {
        visit(child);
      }
    }
  };
  visit(spTree);
  return paragraphs.join('\n');
}

/**
 * Reads a single XML part out of the archive, rejecting a DOCTYPE and any parse failure before
 * handing the element tree back — every part gets this gate, not just the slide parts, since a
 * hostile presentation.xml or relationship file is exactly as dangerous as a hostile slide.
 */
async function readXmlPart(zip: JSZip, partPath: string): Promise<Element> {
  const entry = zip.file(partPath);
  if (!entry) {
    throw new MalformedPptxException(`Archive is missing ${partPath}`);
  }
  const xml = await entry.async('text');

  // Reject outright rather than parse-and-ignore: even without external-entity resolution, a
  // DOCTYPE's internal subset can still define entities that expand at parse time (the
  // "billion laughs" pattern), so refusing any DOCTYPE at all is the only fail-closed option.
  if (DOCTYPE_PATTERN.test(xml)) {
    throw new HostileArchiveException(`${partPath} declares a DOCTYPE`);
  }

  try {
    return xml2js(xml, {
      compact: false,
      trim: false,
      ignoreDeclaration: true,
      ignoreInstruction: true,
      ignoreComment: true,
    }) as Element;
  } catch (error) {
    throw new MalformedPptxException(`${partPath} is not well-formed XML`, error);
  }
}

/**
 * Reads `ppt/presentation.xml`, `ppt/_rels/presentation.xml.rels`, and each slide part it points
 * at, rather than rendering through a converter: a renderer exposes no stable slide ordinal, and
 * `PptxSlideLocator` needs exactly that to make a citation resolvable back to an exact slide.
 */
export class PptxParser implements DocumentParser {
  readonly supports = [PPTX_MIME_TYPE];

  async parse(content: Buffer): Promise<ParsedDocument> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(content);
    } catch (error) {
      throw new MalformedPptxException('Could not open the file as a zip archive', error);
    }
    assertSafeArchive(zip);

    const presentationRoot = await readXmlPart(zip, 'ppt/presentation.xml');
    const relsRoot = await readXmlPart(zip, 'ppt/_rels/presentation.xml.rels');

    const relationshipTargets = new Map<string, string>();
    const relationshipsElement = findFirst(relsRoot, 'Relationships');
    for (const relationship of relationshipsElement?.elements ?? []) {
      if (relationship.name !== 'Relationship') {
        continue;
      }
      const id = relationship.attributes?.Id;
      const target = relationship.attributes?.Target;
      if (typeof id === 'string' && typeof target === 'string') {
        relationshipTargets.set(id, target);
      }
    }

    // The single most important correctness property in this parser: slide order comes from
    // <p:sldIdLst> in presentation.xml, resolved through the relationship file above — NEVER
    // from sorting slide part filenames. OOXML does not guarantee that "slide1.xml, slide2.xml,
    // …" matches presentation order, and a deck saved (or reordered) by some tools genuinely
    // leaves that assumption false. Filename-sorting here would silently cite the wrong slide.
    const sldIdLst = findFirst(presentationRoot, 'p:sldIdLst');
    const slideRefs = (sldIdLst?.elements ?? []).filter((el) => el.name === 'p:sldId');

    const elements: ParsedElement[] = [];

    for (const [index, sldId] of slideRefs.entries()) {
      const relId = sldId.attributes?.['r:id'];
      if (typeof relId !== 'string') {
        throw new MalformedPptxException(`sldIdLst entry ${index + 1} has no r:id`);
      }
      const target = relationshipTargets.get(relId);
      if (!target) {
        throw new MalformedPptxException(
          `Slide relationship "${relId}" is not declared in presentation.xml.rels`,
        );
      }
      // Relationship targets are relative to the referencing part's directory (ppt/) unless
      // they start with a leading slash, in which case they are already package-root-relative.
      const slidePartPath = target.startsWith('/') ? target.slice(1) : `ppt/${target}`;

      const slideRoot = await readXmlPart(zip, slidePartPath);
      const spTree = findFirst(slideRoot, 'p:spTree');
      const text = spTree ? collectSlideText(spTree) : '';

      // Notes, masters, and layouts are excluded on purpose: they are not presented evidence.
      // This isn't a filter step — it falls out of only ever following the slide relationship
      // targets above, since notes/master/layout parts are never referenced by sldIdLst.
      const slideNumber = index + 1;
      const locator: PptxSlideLocator = {
        kind: 'pptx-slide',
        slide: slideNumber,
        extractorVersion: EXTRACTOR_VERSION,
      };

      elements.push({
        text: sanitizeEvidenceText(text),
        locator,
        // Decks carry no heading structure to chunk by, so every element gets an empty trail —
        // chunking treats slide text as prose rather than pretending a heading hierarchy exists.
        headingPath: [],
      });
    }

    return { elements, extractorVersion: EXTRACTOR_VERSION };
  }
}
