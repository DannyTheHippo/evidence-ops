import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { HttpStatus } from '@nestjs/common';
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { BaseException } from '../../../../shared/exceptions/base.exception';
import type { PdfPageLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';

const PDF_MIME_TYPE = 'application/pdf';

// Bump whenever a change here could shift the page number or bounding-box coordinates a stored
// citation already points at.
const EXTRACTOR_VERSION = 'pdf-pdfjs-1';

// Under Jest, the ambient `require` is jest-runtime's own module registry, which cannot execute
// an ES module without `extensionsToTreatAsEsm`/`--experimental-vm-modules` configured (neither
// is set here). `createRequire` reaches past that registry to Node's real module loader — the
// same one this code runs under in production, where Node's own `require()` has supported
// synchronously loading a top-level-await-free ES module (which pdf.js's legacy build is built
// to be) since Node 22.
const nativeRequire = createRequire(__filename);

// pdf.js needs these on disk for glyph metrics of non-embedded standard fonts and for CJK/Type0
// CMaps; resolved from the installed package rather than hardcoded so the path survives
// `npm install` moving node_modules around.
const PDFJS_ROOT = dirname(nativeRequire.resolve('pdfjs-dist/package.json'));
const STANDARD_FONT_DATA_URL = `${join(PDFJS_ROOT, 'standard_fonts')}/`;
const CMAP_URL = `${join(PDFJS_ROOT, 'cmaps')}/`;

// A horizontal gap between two text items wider than this fraction of the line's own font-size
// scale is treated as a token boundary pdf.js did not already encode as a literal space
// character in either item's `str`. Tuned to a conservative quarter-em: PDF word spacing is
// typically close to a full em, so this catches real gaps without inserting spaces inside a
// single word that pdf.js happened to split into adjacent runs (e.g. a font change mid-word).
const WORD_GAP_RATIO = 0.25;

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsModule: PdfjsModule | undefined;

/**
 * pdfjs-dist ships ESM-only (`.mjs`, no CJS build) while this project compiles to CommonJS (no
 * `"type": "module"` in package.json). Neither a static `import` nor Jest's own ambient `require`
 * can load it here (see `nativeRequire` above); `nativeRequire`'s synchronous ESM interop is what
 * makes this work identically under Jest and in production. Cached because the load itself has
 * real cost and every call resolves the same module.
 */
function loadPdfjs(): PdfjsModule {
  pdfjsModule ??= nativeRequire('pdfjs-dist/legacy/build/pdf.mjs') as PdfjsModule;
  return pdfjsModule;
}

/**
 * This is an input gate, so it fails CLOSED: any failure to open or walk the document — a
 * missing PDF header, a truncated byte stream, an unparseable cross-reference table — rejects
 * the whole file rather than returning whatever pages happened to parse.
 */
export class MalformedPdfException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
  }
}

/**
 * A scanned page with no embedded text layer parses without error and yields zero extracted
 * text — indistinguishable from a legitimately empty page unless checked explicitly. This closes
 * exactly that gap: at least one page present and every page's extracted text empty rejects the
 * whole document rather than completing to zero chunks. OCR is out of scope for this parser and
 * stays out; the thrown message says so.
 *
 * A document with zero pages is a different condition and is not covered here — `parse()` still
 * returns an empty `elements` array for it, unchanged.
 */
export class EmptyPdfTextLayerException extends BaseException {
  constructor(message: string, cause?: unknown) {
    super(message, HttpStatus.BAD_REQUEST, cause);
    // Named explicitly, matching `VoyageApiKeyMissingError`'s pattern: Temporal's
    // `nonRetryableErrorTypes` (`ingest-document-version.workflow.ts`) classifies an activity
    // failure by `error.name`, which a class extending `Error`/`HttpException` never sets on its
    // own — every instance would otherwise report `'Error'` regardless of subclass.
    this.name = 'EmptyPdfTextLayerException';
  }
}

// `PDFPageProxy.getTextContent()`'s resolved shape is not re-exported from pdfjs-dist's
// top-level type barrel (only `PDFDocumentProxy`/`PDFPageProxy`/`PageViewport` are); deriving it
// from the method itself avoids reaching into an internal `display/api` path that is not part of
// the package's declared public surface, and stays correct automatically if the library's item
// shape changes.
type TextContentItem = Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number];
type PdfTextItem = Extract<TextContentItem, { str: string }>;

/** `TextMarkedContent` items only appear when `includeMarkedContent` is requested; we never do,
 * but the library still types `items` as the union, so every item needs this narrowing. */
function isTextItem(item: TextContentItem): item is PdfTextItem {
  return 'str' in item;
}

interface PageContent {
  readonly text: string;
  readonly boundingBox: { x: number; y: number; width: number; height: number };
}

/**
 * Applies a pdf.js viewport's affine transform (bottom-left PDF space → top-left viewport space,
 * already accounting for page rotation) to a single point. `PageViewport.transform` is a plainly
 * typed `number[]`, unlike the loosely-typed `convertToViewportPoint`/`convertToViewportRectangle`
 * helpers pdf.js exposes elsewhere — applying it directly here is what lets every coordinate in
 * this file stay real numbers end to end.
 */
function toViewportPoint(
  transform: readonly number[],
  x: number,
  y: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = transform;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** `TextItem.transform` is typed `Array<any>` by pdf.js (it is passed straight through from an
 * untyped internal matrix); validating it once here — rather than at every arithmetic use — is
 * what keeps `any` from leaking into every coordinate computation downstream. */
function toNumberArray(values: unknown[]): number[] {
  return values.map((value) => {
    if (typeof value !== 'number') {
      throw new Error('pdf.js returned a non-numeric coordinate in a text item transform');
    }
    return value;
  });
}

/** The item's PDF-space origin: `transform[4]`/`transform[5]` are the matrix's translation
 * component (see `DocumentParser`/pdf.js docs) — the baseline start point every other coordinate
 * for the item is computed from. */
function itemOrigin(item: PdfTextItem): { x: number; y: number } {
  const transform = toNumberArray(item.transform);
  return { x: transform[4], y: transform[5] };
}

/**
 * A gap wider than `WORD_GAP_RATIO` of the line's font-size scale between the end of one item
 * and the start of the next is a word boundary pdf.js did not encode as a literal space — without
 * this, adjacent runs (common whenever a line has more than one font/style change) would read as
 * one glued-together word.
 */
function needsWordGap(previous: PdfTextItem, current: PdfTextItem): boolean {
  if (previous.str.length === 0 || current.str.length === 0) {
    return false;
  }
  if (/\s$/.test(previous.str) || /^\s/.test(current.str)) {
    return false;
  }
  const previousEndX = itemOrigin(previous).x + previous.width;
  const gap = itemOrigin(current).x - previousEndX;
  const threshold = Math.max(previous.height, current.height) * WORD_GAP_RATIO;
  return gap > threshold;
}

/**
 * Joins a page's positioned text items into prose and unions their boxes into one page-level
 * bounding box. One `ParsedElement` per page (not per item) per the `DocumentParser` contract: a
 * page is the smallest unit `PdfPageLocator` can address, so finer-grained elements would only
 * fragment sentences without narrowing anything a citation could point at.
 */
function buildPageContent(items: readonly PdfTextItem[], viewport: PageViewport): PageContent {
  let text = '';
  let previous: PdfTextItem | undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const item of items) {
    const { x, y } = itemOrigin(item);
    // Item `width`/`height` are already final PDF-space magnitudes along the item's own
    // (typically horizontal, unrotated) run direction — see pdf.js's text-content evaluator,
    // which accumulates them as `Math.hypot(...)`-based advance sums, not raw glyph-space units
    // still awaiting the transform's scale. Treating (x, y)–(x+width, y+height) as an
    // axis-aligned PDF-space box is therefore correct for the common unrotated case this
    // fixture corpus and most business documents fall into; a rotated text run would need the
    // item's own rotation applied to those extents too, which this does not attempt.
    const corners = [
      toViewportPoint(viewport.transform, x, y),
      toViewportPoint(viewport.transform, x + item.width, y + item.height),
    ];
    for (const corner of corners) {
      minX = Math.min(minX, corner.x);
      minY = Math.min(minY, corner.y);
      maxX = Math.max(maxX, corner.x);
      maxY = Math.max(maxY, corner.y);
    }

    if (previous) {
      // `hasEOL` is pdf.js's own line-break signal (it already tracks vertical position to
      // compute it); trusting it instead of re-deriving line breaks from raw y-deltas avoids
      // duplicating logic the library already got right.
      if (previous.hasEOL) {
        text += '\n';
      } else if (needsWordGap(previous, item)) {
        text += ' ';
      }
    }
    text += item.str;
    previous = item;
  }

  const boundingBox = Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : { x: 0, y: 0, width: viewport.width, height: viewport.height };

  return { text, boundingBox };
}

/**
 * Extracts one `ParsedElement` per page via pdf.js's text-content API — no canvas, no rendering,
 * text-only. `pdfjs-dist`'s Node fallback runs the worker logic in-process (`PDFWorker` disables
 * itself under `isNodeJS`), so no worker script path needs configuring.
 */
export class PdfParser implements DocumentParser {
  readonly supports = [PDF_MIME_TYPE];

  async parse(content: Buffer): Promise<ParsedDocument> {
    const pdfjs = loadPdfjs();
    const loadingTask = pdfjs.getDocument({
      // pdf.js rejects a Node `Buffer` outright ("Please provide binary data as `Uint8Array`"),
      // even though Buffer extends Uint8Array — it checks the constructor, not the prototype
      // chain.
      //
      // pdf.js also takes ownership of whatever `data` array it is handed and detaches
      // (transfers) its underlying `ArrayBuffer` once the document is done with it — a view over
      // `content`'s own memory would leave `content` unreadable after the first parse, breaking
      // any caller that parses the same buffer twice (this pipeline does, once to chunk and once
      // to extract facts). Worse, Node pools `Buffer`s under ~half its pool size inside a shared
      // `ArrayBuffer`; detaching that shared buffer would silently corrupt unrelated pooled
      // `Buffer`s that happen to share the slab, not just this one. `new Uint8Array(content)`
      // copies the bytes into a fresh, dedicated `ArrayBuffer` pdf.js can safely take ownership of
      // and detach without touching the caller's memory. Cost: one copy per parse, bounded by the
      // upload size cap.
      data: new Uint8Array(content),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      disableFontFace: true,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });

    try {
      const doc: PDFDocumentProxy = await loadingTask.promise;
      const elements: ParsedElement[] = [];

      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const { text, boundingBox } = buildPageContent(
          textContent.items.filter(isTextItem),
          viewport,
        );

        const locator: PdfPageLocator = {
          kind: 'pdf-page',
          page: pageNumber,
          boundingBox,
          extractorVersion: EXTRACTOR_VERSION,
        };

        elements.push({
          text: sanitizeEvidenceText(text),
          locator,
          headingPath: [],
        });
      }

      if (doc.numPages > 0 && elements.every((element) => element.text.trim().length === 0)) {
        throw new EmptyPdfTextLayerException(
          `Document has ${doc.numPages} page(s) but no extractable text on any of them ` +
            '(likely a scanned image with no embedded text layer); OCR is out of scope for this parser',
        );
      }

      return { elements, extractorVersion: EXTRACTOR_VERSION };
    } catch (error) {
      if (error instanceof EmptyPdfTextLayerException) {
        throw error;
      }
      throw new MalformedPdfException('Could not parse the file as a PDF document', error);
    } finally {
      await loadingTask.destroy();
    }
  }
}
