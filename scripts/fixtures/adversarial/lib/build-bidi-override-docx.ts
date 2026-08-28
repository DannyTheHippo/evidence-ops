import { Document, Packer, Paragraph, TextRun } from 'docx';
import { DOCUMENT_AUTHOR } from './constants';
import { patchDocxCoreProps } from '../../lib/patch-docx-core-props';
import { repackDeterministicZip } from '../../lib/repack-zip';

// U+202E RIGHT-TO-LEFT OVERRIDE and U+202C POP DIRECTIONAL FORMATTING — the classic filename-
// spoofing pair: text typed between them reads reversed to anyone rendering it bidi-aware, while
// the underlying code points (and any byte-level string comparison against them) are untouched.
// Embedded in prose here, not a filename, to exercise the claim-alignment gate a citation's quoted
// span passes through — a resolver comparing bytes gets an unambiguous string; a reader looking at
// a bidi-aware rendering sees something else, and that gap is what this fixture is for.
const RLO = '‮';
const PDF = '‬';

const PARAGRAPH_TEXT =
  `Wire confirmation reference: WR-${RLO}txe.4102-2691${PDF}-NF ` +
  '— retain for the fiscal year 2026 audit file.';

export async function buildBidiOverrideDocx(): Promise<Buffer> {
  const document = new Document({
    creator: DOCUMENT_AUTHOR,
    lastModifiedBy: DOCUMENT_AUTHOR,
    title: 'Wire Confirmation Note',
    description: 'Adversarial fixture: embeds a bidi override control character',
    revision: 1,
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun('Wire Confirmation Note')] }),
          new Paragraph({ children: [new TextRun(PARAGRAPH_TEXT)] }),
        ],
      },
    ],
  });

  const rawBuffer = await Packer.toBuffer(document);
  return repackDeterministicZip(rawBuffer, patchDocxCoreProps);
}
