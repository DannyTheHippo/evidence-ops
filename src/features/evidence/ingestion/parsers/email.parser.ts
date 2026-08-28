import type { TextBlockLocator } from '../../../../database/schemas/evidence/evidence-chunk/evidence-locator.type';
import { decodeTextBuffer, encodingFidelityReasons } from '../decode-text-buffer';
import { sanitizeEvidenceText } from '../sanitize-evidence-text';
import { parseEmailMessage } from './email-mime';
import type { DocumentParser, ParsedDocument, ParsedElement } from './parsed-element.type';

// Mirrors the 'eml' entry of SOURCE_KIND_TO_MIME_TYPE (documents.constant.ts), duplicated rather
// than imported for the same reason `text.parser.ts` duplicates its own: this is what the class
// claims per the `DocumentParser.supports` contract, not the upload gate's allowlist.
const EMAIL_MIME_TYPE = 'message/rfc822';

// Bump whenever a change here could shift the `blockIndex` a stored citation points at — including
// a change to which envelope fields the leading block carries, since that block occupies index 0
// and shifts every body block after it.
const EXTRACTOR_VERSION = 'email-block-1';

/**
 * Parses an `.eml` into the message's own readable content: an envelope block naming who sent it,
 * when, and about what, followed by its plain-text body split on blank lines.
 *
 * Attachments are deliberately NOT part of this output. An attachment is a document in its own
 * right — `EmailAttachmentService` unwraps each one into its own `Document`, parsed by whichever
 * parser its format calls for, so a spreadsheet that arrived by email cites `xlsx-cell` exactly as
 * an uploaded one does. Folding attachment text into the email's elements would flatten that back
 * into `text-block` coordinates and lose the provenance the unwrapping exists to preserve.
 *
 * Emits `text-block` locators under its own `extractorVersion`, never `TextParser`'s: the two split
 * text differently (no ATX heading trail here — a `#` in an email body is not a Markdown heading)
 * and a citation must be able to say which of them produced its coordinates.
 */
export class EmailParser implements DocumentParser {
  readonly supports = [EMAIL_MIME_TYPE];

  // eslint-disable-next-line @typescript-eslint/require-await -- matches the async `DocumentParser.parse` contract; this parser performs no I/O but keeps the same call shape.
  async parse(content: Buffer): Promise<ParsedDocument> {
    const message = parseEmailMessage(content);

    const decodedBodies = message.bodyParts.map((part) => decodeTextBuffer(part));
    const fidelityReasons = [
      ...message.skippedPartReasons,
      ...new Set(decodedBodies.flatMap((body) => encodingFidelityReasons(body.encoding) ?? [])),
    ];

    const blocks = [
      describeEnvelope(message.envelope, message.attachments.length),
      ...splitBlocks(decodedBodies.map((body) => body.text).join('\n\n')),
    ].filter((block) => block.length > 0);

    const elements: ParsedElement[] = blocks.map((text, blockIndex) => {
      const locator: TextBlockLocator = {
        kind: 'text-block',
        blockIndex,
        headingPath: [],
        extractorVersion: EXTRACTOR_VERSION,
      };
      return { text: sanitizeEvidenceText(text), locator, headingPath: [] };
    });

    return {
      elements,
      extractorVersion: EXTRACTOR_VERSION,
      reducedFidelityReasons: fidelityReasons.length > 0 ? fidelityReasons : undefined,
    };
  }
}

/**
 * The first block of every email document: the envelope fields, as retrievable text. An answer that
 * cites an email has to be able to say who sent it and when, and a header block that lived only in
 * `emailOrigin` metadata would never reach retrieval at all.
 *
 * The values are sender-controlled and are recorded as text on that footing — nothing downstream
 * treats them as identity.
 */
function describeEnvelope(
  envelope: { from?: string; sentAt?: Date; subject?: string; messageId?: string },
  attachmentCount: number,
): string {
  const lines = [
    envelope.from ? `From: ${envelope.from}` : undefined,
    envelope.sentAt ? `Date: ${envelope.sentAt.toISOString()}` : undefined,
    envelope.subject ? `Subject: ${envelope.subject}` : undefined,
    envelope.messageId ? `Message-ID: ${envelope.messageId}` : undefined,
    attachmentCount > 0 ? `Attachments: ${attachmentCount}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}

/** Blank-line split, matching `TextParser`'s rule so an email body and a `.txt` of the same prose
 * chunk the same way. No heading detection: a `#` at the start of an email line is ordinary text. */
function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }
  return blocks;
}
