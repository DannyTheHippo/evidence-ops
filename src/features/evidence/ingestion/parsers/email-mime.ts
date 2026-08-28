import { MAX_FILE_SIZE_BYTES } from '../../documents/documents.constant';
import { HostileEmailException, MalformedEmailException } from '../exceptions/ingestion.exception';
import { decodeTextBuffer } from '../decode-text-buffer';

/**
 * A bounded RFC 5322/2045 reader for the subset of MIME an `.eml` in a data room actually uses:
 * headers, nested multiparts, base64 and quoted-printable transfer encodings, and attachment
 * filenames. It is deliberately a subset and deliberately hand-written, for the same reason
 * `safe-zip.ts` is: the limits are the feature, and a general-purpose mail library materializes
 * every part of a message before any caller gets to say how much of it is acceptable.
 *
 * Everything this module returns is sender-controlled. It resolves structure and nothing else — no
 * caller may treat a filename, a declared content type, or a `Message-ID` as evidence of what a
 * part is.
 */

export interface EmailContainerLimits {
  readonly maxParts: number;
  readonly maxDepth: number;
  readonly maxAttachmentBytes: number;
  readonly maxTotalAttachmentBytes: number;
}

/**
 * What bounds one message's expansion.
 *
 * FAILURE DIRECTION: every one of these fails CLOSED, on the whole message. This is an input gate
 * on the least trustworthy bytes this product accepts, and a partial unwrap of a message that
 * crossed a limit would hand a caller a subset of attachments with no way to know it is a subset.
 *
 * `maxAttachmentBytes` and `maxTotalAttachmentBytes` are `MAX_FILE_SIZE_BYTES`: an attachment must
 * not get more past the gate than uploading the same file directly would, and the sum of what one
 * email expands into must not exceed one upload's worth either. The upload and sync gates cap the
 * `.eml` at the same figure, but that caps ENCODED bytes — the decoded total is what these bound,
 * and this module is also callable by anything that did not come through those gates.
 */
export const EMAIL_CONTAINER_LIMITS: EmailContainerLimits = {
  maxParts: 100,
  maxDepth: 5,
  maxAttachmentBytes: MAX_FILE_SIZE_BYTES,
  maxTotalAttachmentBytes: MAX_FILE_SIZE_BYTES,
};

/** One attachment part, decoded out of its transfer encoding and no further. */
export interface EmailAttachmentPart {
  /** Ordinal within the message, in the order the MIME walk reached the parts. Stable for the same
   * bytes, which is what lets an unwrapped attachment be found again instead of re-created. */
  readonly partIndex: number;
  /** Sanitized for display and for extension resolution. Never a path — see
   * `sanitizeAttachmentFilename`. */
  readonly filename: string;
  /** What the message SAYS this part is. Held against the bytes by the caller, never trusted. */
  readonly declaredMimeType: string;
  readonly content: Buffer;
}

export interface EmailEnvelope {
  readonly messageId?: string;
  readonly from?: string;
  readonly subject?: string;
  readonly sentAt?: Date;
}

export interface EmailMessage {
  readonly envelope: EmailEnvelope;
  /** Decoded `text/plain` bodies, in walk order. Empty when a message carries no plain-text
   * alternative at all. */
  readonly bodyParts: readonly Buffer[];
  readonly attachments: readonly EmailAttachmentPart[];
  /**
   * One entry per part this reader declined to use, naming why. An honest part this product has no
   * parser for — a signature image, a calendar invite, an HTML-only alternative — is skipped rather
   * than rejected, because rejecting it would fail every real email that carries one. Skipping
   * never ingests anything, so the gate stays closed; these strings are what keep the skip visible
   * instead of silent.
   */
  readonly skippedPartReasons: readonly string[];
}

interface StructuredHeader {
  readonly value: string;
  readonly params: Readonly<Record<string, string>>;
}

interface WalkState {
  readonly bodyParts: Buffer[];
  readonly attachments: EmailAttachmentPart[];
  readonly skippedPartReasons: string[];
  readonly limits: EmailContainerLimits;
  /** Every part the walk has entered, container parts included — a message that spends its budget
   * on empty `multipart/*` wrappers has still made the walk do the work. */
  partsWalked: number;
  totalAttachmentBytes: number;
}

const LF = 0x0a;

/**
 * Splits a header block from a body at the first empty line. Fails CLOSED at the top level: a
 * buffer with no empty line anywhere is not a message, and returning it as a bodyless header block
 * would present a truncated or non-email upload as an email that simply had nothing in it.
 */
function splitHeadersAndBody(raw: Buffer): { headerText: string; body: Buffer } | undefined {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');

  // The earlier separator wins, not CRLF unconditionally: a message written with bare LF endings
  // contains no CRLFCRLF at all, and one with mixed endings separates at whichever comes first.
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { headerText: raw.subarray(0, crlf).toString('latin1'), body: raw.subarray(crlf + 4) };
  }
  if (lf !== -1) {
    return { headerText: raw.subarray(0, lf).toString('latin1'), body: raw.subarray(lf + 2) };
  }
  return undefined;
}

/**
 * Header names lowercased, values unfolded. A repeated header keeps its first value: the fields
 * this reader consults are single-valued by definition, and a second `Content-Type` is a sender
 * trying to make two readers disagree about the same part.
 */
function parseHeaders(headerText: string): ReadonlyMap<string, string> {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!headers.has(name)) {
      headers.set(name, line.slice(separator + 1).trim());
    }
  }
  return headers;
}

/**
 * Splits a structured header (`Content-Type`, `Content-Disposition`) into its value and its
 * parameters, honouring quoted parameter values so a `;` or `=` inside a filename does not split
 * it. Unknown or malformed parameters are dropped rather than guessed.
 */
function parseStructuredHeader(raw: string): StructuredHeader {
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === ';' && !inQuotes) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const separator = segment.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = segment.slice(0, separator).trim().toLowerCase();
    const value = segment.slice(separator + 1).trim();
    const unquoted =
      value.startsWith('"') && value.endsWith('"') && value.length >= 2
        ? value.slice(1, -1)
        : value;
    if (!(name in params)) {
      params[name] = unquoted;
    }
  }

  return { value: segments[0].trim().toLowerCase(), params };
}

/**
 * Decodes a quoted-printable body: `=XX` hex escapes, `=` soft line breaks, everything else
 * verbatim. Read as latin1 so each source character is exactly one byte — a QP body is 7-bit by
 * definition, and reading it any other way would let a stray high byte become several.
 *
 * An `=` that introduces neither a soft break nor a valid hex pair is kept as a literal `=`. Fails
 * OPEN, deliberately: a malformed escape is a transport artifact, not a claim about content, and
 * refusing the part over one would reject mail that every other reader displays.
 */
function decodeQuotedPrintable(body: Buffer): Buffer {
  const text = body.toString('latin1');
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '=') {
      bytes.push(text.charCodeAt(index) & 0xff);
      continue;
    }
    if (text.startsWith('\r\n', index + 1)) {
      index += 2;
      continue;
    }
    if (text[index + 1] === '\n') {
      index += 1;
      continue;
    }
    const hex = text.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(0x3d);
  }
  return Buffer.from(bytes);
}

/**
 * Reverses a part's `Content-Transfer-Encoding`. `undefined` means the encoding is one this reader
 * does not implement — the caller skips the part visibly rather than passing bytes downstream in a
 * form it has not actually decoded.
 */
function decodeTransferEncoding(body: Buffer, encoding: string): Buffer | undefined {
  switch (encoding) {
    case '':
    case '7bit':
    case '8bit':
    case 'binary':
      return body;
    case 'base64':
      return Buffer.from(body.toString('latin1'), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    default:
      return undefined;
  }
}

const ENCODED_WORD_PATTERN = /=\?[^?]+\?([BbQq])\?([^?]*)\?=/g;

/**
 * Expands RFC 2047 encoded words in a header value. The declared charset is not consulted: the
 * decoded bytes go through `decodeTextBuffer`, the same detection ladder every other text this
 * product reads goes through, so a charset label that disagrees with its own bytes resolves the
 * same way a mislabelled CSV does.
 */
function decodeEncodedWords(value: string): string {
  return value.replace(ENCODED_WORD_PATTERN, (match: string, ...groups: string[]): string => {
    const [encoding, payload] = groups;
    const bytes =
      encoding.toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64')
        : decodeQuotedPrintable(Buffer.from(payload.replace(/_/g, ' '), 'latin1'));
    return bytes.length > 0 ? decodeTextBuffer(bytes).text : match;
  });
}

// Everything outside this set is replaced 1:1 with `_`, the same rule and the same reason as
// `sanitizeDownloadFilename`: replacing rather than stripping keeps two different hostile names
// from collapsing onto one.
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._ -]/g;
const MAX_FILENAME_LENGTH = 200;

/**
 * Reduces a sender-chosen attachment name to a display string that also carries a usable extension.
 *
 * A filename in email is attacker text and is never a path here — stored bytes are addressed by
 * `DocumentVersion.storageKey`, which this value never reaches. The path handling below is
 * therefore about identity, not about the filesystem: `../../etc/passwd` and `passwd` must not
 * become the same document title, and a name whose only content is separators and dots resolves to
 * nothing usable rather than to a traversal-looking title.
 *
 * Truncation keeps the tail, because the extension is the part `resolveUploadKind` reads.
 */
export function sanitizeAttachmentFilename(raw: string): string | undefined {
  const lastSeparator = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const base = lastSeparator === -1 ? raw : raw.slice(lastSeparator + 1);
  const sanitized = base.replace(UNSAFE_FILENAME_CHARS, '_').trim();
  if (sanitized.length === 0 || /^\.+$/.test(sanitized)) {
    return undefined;
  }
  return sanitized.length > MAX_FILENAME_LENGTH
    ? sanitized.slice(sanitized.length - MAX_FILENAME_LENGTH)
    : sanitized;
}

interface BoundaryMark {
  readonly start: number;
  readonly lineEnd: number;
  readonly closing: boolean;
}

/**
 * Locates every boundary delimiter line in a multipart body. A delimiter counts only at the start
 * of a line and only when the rest of that line is empty (a part delimiter) or exactly `--` (the
 * closing delimiter) — so the boundary string appearing inside a part's own content is not mistaken
 * for structure.
 */
function findBoundaryMarks(body: Buffer, boundary: string): BoundaryMark[] {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const marks: BoundaryMark[] = [];
  let index = body.indexOf(delimiter);
  while (index !== -1) {
    if (index === 0 || body[index - 1] === LF) {
      const newline = body.indexOf(LF, index);
      const lineEnd = newline === -1 ? body.length : newline;
      const trailer = body
        .subarray(index + delimiter.length, lineEnd)
        .toString('latin1')
        .trim();
      if (trailer === '' || trailer === '--') {
        marks.push({ start: index, lineEnd, closing: trailer === '--' });
      }
    }
    index = body.indexOf(delimiter, index + delimiter.length);
  }
  return marks;
}

/** Drops the CRLF or LF that belongs to the delimiter line following a part, not to the part. */
function trimPartTrailer(part: Buffer): Buffer {
  if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === LF) {
    return part.subarray(0, part.length - 2);
  }
  if (part.length >= 1 && part[part.length - 1] === LF) {
    return part.subarray(0, part.length - 1);
  }
  return part;
}

/**
 * Splits a multipart body into its parts. Fails CLOSED on a body with no delimiter at all and on
 * one whose closing delimiter never arrives — both are what a truncated message looks like, and
 * either would otherwise yield a shorter list of parts than the message actually declares, with
 * nothing to say so.
 */
function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const marks = findBoundaryMarks(body, boundary);
  if (marks.length === 0) {
    throw new MalformedEmailException(
      `Multipart body declares boundary "${boundary}" but contains no delimiter line for it`,
    );
  }
  if (!marks.some((mark) => mark.closing)) {
    throw new MalformedEmailException(
      `Multipart body declares boundary "${boundary}" and never closes it`,
    );
  }

  const parts: Buffer[] = [];
  for (let index = 0; index < marks.length - 1; index += 1) {
    const mark = marks[index];
    if (mark.closing) {
      break;
    }
    parts.push(trimPartTrailer(body.subarray(mark.lineEnd + 1, marks[index + 1].start)));
  }
  return parts;
}

/**
 * Walks one MIME part, appending whatever it yields to `state`. A `multipart/*` part recurses into
 * its children; every other part is a leaf that becomes body text, an attachment, or a recorded
 * skip.
 */
function walkPart(headerText: string, body: Buffer, state: WalkState, depth: number): void {
  state.partsWalked += 1;
  if (state.partsWalked > state.limits.maxParts) {
    throw new HostileEmailException(
      `Message expands to more than ${state.limits.maxParts} parts, exceeding the limit on what one message may unwrap into`,
    );
  }
  if (depth > state.limits.maxDepth) {
    throw new HostileEmailException(
      `Message nests multipart containers more than ${state.limits.maxDepth} deep`,
    );
  }

  const headers = parseHeaders(headerText);
  const contentType = parseStructuredHeader(headers.get('content-type') ?? 'text/plain');

  if (contentType.value.startsWith('multipart/')) {
    const boundary = contentType.params.boundary;
    if (!boundary) {
      throw new MalformedEmailException(
        `A '${contentType.value}' part declares no boundary parameter`,
      );
    }
    for (const part of splitMultipart(body, boundary)) {
      const split = splitHeadersAndBody(part);
      // A part with no empty line carries no headers of its own, which RFC 2046 permits: it is all
      // body, and the defaults (`text/plain`, 7bit) apply. Only the top-level message treats a
      // missing separator as malformed, because there the whole upload is what lacks structure.
      if (split) {
        walkPart(split.headerText, split.body, state, depth + 1);
      } else {
        walkPart('', part, state, depth + 1);
      }
    }
    return;
  }

  const disposition = parseStructuredHeader(headers.get('content-disposition') ?? '');
  const transferEncoding = (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
  const rawFilename = disposition.params.filename ?? contentType.params.name;
  const filename =
    rawFilename === undefined
      ? undefined
      : sanitizeAttachmentFilename(decodeEncodedWords(rawFilename));

  const decoded = decodeTransferEncoding(body, transferEncoding);
  if (!decoded) {
    state.skippedPartReasons.push(
      `A '${contentType.value}' part uses the unsupported transfer encoding '${transferEncoding}' and was not unwrapped`,
    );
    return;
  }

  const isAttachment = disposition.value === 'attachment' || rawFilename !== undefined;
  if (isAttachment) {
    if (filename === undefined) {
      state.skippedPartReasons.push(
        `A '${contentType.value}' attachment carries no usable filename and was not unwrapped`,
      );
      return;
    }

    // A message carried inside a message is a container inside a container, and unwrapping it would
    // put this walk back at its own entry point with a fresh budget. Refused rather than skipped:
    // it is a bound, not a format this product merely lacks a parser for, and `.eml` being on the
    // upload allowlist is exactly what would otherwise make the recursion available.
    if (contentType.value === 'message/rfc822' || filename.toLowerCase().endsWith('.eml')) {
      throw new HostileEmailException(
        `Attachment '${filename}' is itself a message; a message nested inside a message is not unwrapped`,
      );
    }

    if (decoded.length > state.limits.maxAttachmentBytes) {
      throw new HostileEmailException(
        `Attachment '${filename}' decodes to ${decoded.length} bytes, over the ${state.limits.maxAttachmentBytes}-byte per-attachment limit`,
      );
    }
    state.totalAttachmentBytes += decoded.length;
    if (state.totalAttachmentBytes > state.limits.maxTotalAttachmentBytes) {
      throw new HostileEmailException(
        `Message attachments decode to more than the ${state.limits.maxTotalAttachmentBytes}-byte total limit`,
      );
    }

    state.attachments.push({
      partIndex: state.attachments.length,
      filename,
      declaredMimeType: contentType.value,
      content: decoded,
    });
    return;
  }

  if (contentType.value === 'text/plain') {
    state.bodyParts.push(decoded);
    return;
  }

  state.skippedPartReasons.push(
    `A '${contentType.value}' part is not plain text and carries no filename; it was not unwrapped`,
  );
}

function parseSentAt(raw: string | undefined): Date | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readEnvelope(headers: ReadonlyMap<string, string>): EmailEnvelope {
  const messageId = headers.get('message-id')?.trim().replace(/^<|>$/g, '');
  const from = headers.get('from');
  const subject = headers.get('subject');
  return {
    messageId: messageId && messageId.length > 0 ? messageId : undefined,
    from: from ? decodeEncodedWords(from) : undefined,
    subject: subject ? decodeEncodedWords(subject) : undefined,
    sentAt: parseSentAt(headers.get('date')),
  };
}

/**
 * Reads an `.eml` buffer into its envelope, its plain-text bodies, and its attachments.
 *
 * FAILURE DIRECTION: CLOSED. This is an input gate on the least trustworthy bytes this product
 * accepts. A message whose structure does not hold together throws `MalformedEmailException` rather
 * than returning an empty result, so a truncated or non-email upload reaches a visible terminal
 * state instead of presenting as an email that happened to contain nothing.
 */
export function parseEmailMessage(
  content: Buffer,
  limits: EmailContainerLimits = EMAIL_CONTAINER_LIMITS,
): EmailMessage {
  const split = splitHeadersAndBody(content);
  if (!split) {
    throw new MalformedEmailException(
      'Message has no header block: no empty line separates headers from a body',
    );
  }

  const headers = parseHeaders(split.headerText);
  if (headers.size === 0) {
    throw new MalformedEmailException('Message header block contains no readable header field');
  }

  const state: WalkState = {
    bodyParts: [],
    attachments: [],
    skippedPartReasons: [],
    limits,
    partsWalked: 0,
    totalAttachmentBytes: 0,
  };
  walkPart(split.headerText, split.body, state, 0);

  return {
    envelope: readEnvelope(headers),
    bodyParts: state.bodyParts,
    attachments: state.attachments,
    skippedPartReasons: state.skippedPartReasons,
  };
}
