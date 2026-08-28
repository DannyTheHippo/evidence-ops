import { buildSemicolonCsv } from './build-semicolon-csv';
import { buildTwoColumnPdf } from './build-two-column-pdf';
import { buildTwoRowHeaderSheet } from './build-two-row-header-sheet';

/**
 * The `.eml` half of the adversarial corpus: one honest email carrying a real spreadsheet, and the
 * container-class shapes an email can take that the unwrapper has to reach a bounded, visible
 * outcome on.
 *
 * Every buffer here is assembled from fixed strings and from the existing deterministic builders,
 * so two generator runs produce identical bytes. The unbounded shapes — many attachments, an
 * oversized payload, deep nesting — are built in memory by the spec that needs them rather than
 * committed, mirroring `build-huge-xlsx.ts`: they are large, and their point is the limit they
 * cross, not the bytes they contain.
 */

const CRLF = '\r\n';
const MESSAGE_ID = 'kestrel-point-q3-2026@meridian-facilities.example';
const SENT_AT = 'Tue, 04 Aug 2026 09:14:00 +0000';
const FROM = 'Dana Okonkwo <dana.okonkwo@meridian-facilities.example>';

/** Wraps base64 at the 76-character line length RFC 2045 specifies, so the fixtures look like what
 * a real mail client emits rather than one unbroken line. */
function encodeBase64Body(buffer: Buffer): string {
  const encoded = buffer.toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join(CRLF);
}

function topHeaders(subject: string, extra: readonly string[] = []): string[] {
  return [
    'Return-Path: <dana.okonkwo@meridian-facilities.example>',
    `From: ${FROM}`,
    'To: Analytics Intake <intake@evidence-ops.example>',
    `Subject: ${subject}`,
    `Date: ${SENT_AT}`,
    `Message-ID: <${MESSAGE_ID}>`,
    'MIME-Version: 1.0',
    ...extra,
  ];
}

interface AttachmentSpec {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Buffer;
}

function attachmentPart(boundary: string, attachment: AttachmentSpec): string {
  return [
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    '',
    encodeBase64Body(attachment.content),
    '',
  ].join(CRLF);
}

function textPart(boundary: string, text: string): string {
  return [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    text,
    '',
  ].join(CRLF);
}

/** A multipart/mixed message: a plain-text body followed by each attachment, closed properly. */
export function buildMultipartEmail(
  subject: string,
  bodyText: string,
  attachments: readonly AttachmentSpec[],
  boundary = 'evidence-ops-boundary-01',
): Buffer {
  return Buffer.from(
    [
      ...topHeaders(subject, [`Content-Type: multipart/mixed; boundary="${boundary}"`]),
      '',
      // Preamble: everything before the first delimiter is transport text no reader displays.
      'This is a multi-part message in MIME format.',
      textPart(boundary, bodyText),
      ...attachments.map((attachment) => attachmentPart(boundary, attachment)),
      `--${boundary}--`,
      '',
    ].join(CRLF),
    'utf8',
  );
}

const BODY_TEXT = [
  'Hi team,',
  '',
  '# Kestrel Point Q3',
  '',
  'The comps extract for Kestrel Point is attached. Occupancy held at the level we',
  'discussed and the suite detail is unchanged from the June pass.',
  '',
  'Dana',
].join(CRLF);

export async function buildEmailWithXlsxAttachment(): Promise<Buffer> {
  const sheet = await buildTwoRowHeaderSheet();
  return buildMultipartEmail('Kestrel Point comps extract', BODY_TEXT, [
    {
      filename: 'kestrel-point-comps.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: sheet,
    },
  ]);
}

/** The same message with everything from the attachment's payload onward cut away, so the closing
 * boundary never arrives — what a message truncated in transit or in storage looks like. */
export async function buildTruncatedEmail(): Promise<Buffer> {
  const whole = await buildEmailWithXlsxAttachment();
  return whole.subarray(0, Math.floor(whole.length * 0.6));
}

/** Bytes that are not a message at all: no empty line, so no header block ever closes. */
export function buildHeaderlessEmail(): Buffer {
  return Buffer.from(
    ['Subject: this line looks like a header', 'and this line just keeps going', ''].join(CRLF),
    'utf8',
  );
}

/** An attachment that declares a spreadsheet and carries PDF bytes — the declared type, the
 * extension, and the actual content disagreeing inside a container. */
export async function buildDisguisedAttachmentEmail(): Promise<Buffer> {
  const pdf = await buildTwoColumnPdf();
  return buildMultipartEmail('Q3 ledger', BODY_TEXT, [
    {
      filename: 'kestrel-point-ledger.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: pdf.buffer,
    },
  ]);
}

/** An attachment whose filename is a path traversal. The bytes are an ordinary CSV: the hostile
 * part is the name, which is sender-chosen text. */
export function buildHostileFilenameEmail(): Buffer {
  return buildMultipartEmail('Suite export', BODY_TEXT, [
    {
      filename: '../../../etc/passwd.csv',
      mimeType: 'text/csv',
      content: buildSemicolonCsv(),
    },
  ]);
}

/** A message whose only alternative is HTML, so there is no plain-text body to extract. */
export function buildHtmlOnlyEmail(): Buffer {
  const boundary = 'evidence-ops-alt-01';
  return Buffer.from(
    [
      ...topHeaders('Kestrel Point summary', [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ]),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      '<html><body><p>Occupancy held at 94%.</p></body></html>',
      '',
      `--${boundary}--`,
      '',
    ].join(CRLF),
    'utf8',
  );
}

/** A message with no multipart structure at all — one plain-text body, no attachments. */
export function buildSinglePartEmail(): Buffer {
  return Buffer.from(
    [
      ...topHeaders('Kestrel Point note', [
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 7bit',
      ]),
      '',
      BODY_TEXT,
      '',
    ].join(CRLF),
    'utf8',
  );
}

/** Headers that close correctly with nothing after them. */
export function buildEmptyBodyEmail(): Buffer {
  return Buffer.from(
    [
      ...topHeaders('Kestrel Point (no body)', [
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 7bit',
      ]),
      '',
      '',
    ].join(CRLF),
    'utf8',
  );
}

/** A message carrying another whole message as an attachment — a container inside a container. */
export async function buildNestedMessageEmail(): Promise<Buffer> {
  const inner = await buildEmailWithXlsxAttachment();
  return buildMultipartEmail(
    'Fwd: Kestrel Point comps extract',
    BODY_TEXT,
    [{ filename: 'forwarded.eml', mimeType: 'message/rfc822', content: inner }],
    'evidence-ops-boundary-fwd',
  );
}

/** Many small attachments in one message — the count dimension, built in memory. */
export function buildManyAttachmentEmail(count: number): Buffer {
  const attachments: AttachmentSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    attachments.push({
      filename: `extract-${index}.csv`,
      mimeType: 'text/csv',
      content: Buffer.from(`suite,rent\r\nA${index},1000\r\n`, 'utf8'),
    });
  }
  return buildMultipartEmail('Bulk extract', BODY_TEXT, attachments);
}

/** One attachment of `bytes` decoded size — the per-attachment size dimension, built in memory. */
export function buildOversizeAttachmentEmail(bytes: number): Buffer {
  return buildMultipartEmail('Large extract', BODY_TEXT, [
    { filename: 'huge-extract.csv', mimeType: 'text/csv', content: Buffer.alloc(bytes, 0x41) },
  ]);
}

/** `count` attachments of `bytes` each — each one acceptable alone, the sum is the dimension. */
export function buildOversizeTotalEmail(count: number, bytes: number): Buffer {
  const attachments: AttachmentSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    attachments.push({
      filename: `extract-${index}.csv`,
      mimeType: 'text/csv',
      content: Buffer.alloc(bytes, 0x42),
    });
  }
  return buildMultipartEmail('Split extract', BODY_TEXT, attachments);
}

/** `depth` levels of `multipart/mixed` wrapping one plain-text body — the nesting dimension. */
export function buildDeeplyNestedEmail(depth: number): Buffer {
  let inner = ['Content-Type: text/plain; charset="utf-8"', '', 'innermost body', ''].join(CRLF);
  for (let level = depth; level >= 1; level -= 1) {
    const boundary = `evidence-ops-nest-${level}`;
    inner = [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      inner,
      `--${boundary}--`,
      '',
    ].join(CRLF);
  }
  return Buffer.from([...topHeaders('Nested'), inner].join(CRLF), 'utf8');
}
