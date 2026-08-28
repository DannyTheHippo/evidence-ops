import { assembleDraftingMessages } from '../../../../scripts/experiments/verifier/assemble-drafting-messages';
import { makeChunk, makeDocument } from './verifier-fixtures';

/** Vocabulary that would tell the drafting model a checker is downstream. A prompt carrying any of
 *  it makes the measured failure rate a property of the prompt's hedging rather than of the gate,
 *  which is the one result this experiment cannot use. */
const GATE_VOCABULARY = [
  'verify',
  'verification',
  'verifier',
  'grounded',
  'grounding',
  'citation',
  'cite',
  'unsupported',
  'check',
];

describe('assembleDraftingMessages', () => {
  const document = makeDocument({
    filename: 'om.pdf',
    chunks: [
      makeChunk({ chunkId: 'chunk-1', text: 'Net operating income for 2024 was 1,200,000.' }),
      makeChunk({ chunkId: 'chunk-2', text: 'The property has 120 units.' }),
    ],
  });

  it('names no part of the gate anywhere in the prompt', () => {
    const { system, messages } = assembleDraftingMessages(document, 12);
    const prompt =
      `${system}\n${messages.map((message) => message.content).join('\n')}`.toLowerCase();

    for (const word of GATE_VOCABULARY) {
      expect(prompt).not.toContain(word);
    }
  });

  it('asks for the requested number of statements about the named file', () => {
    const { messages } = assembleDraftingMessages(document, 12);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('File: om.pdf');
    expect(messages[0].content).toContain('Write 12 statements about this file.');
  });

  it('puts every chunk of the document in front of the model, in order', () => {
    const { messages } = assembleDraftingMessages(document, 12);

    expect(messages[0].content).toContain(
      'Net operating income for 2024 was 1,200,000.\n\nThe property has 120 units.',
    );
  });

  it('asks for standalone declarative statements', () => {
    const { system } = assembleDraftingMessages(document, 12);

    expect(system).toContain('plain declarative sentence');
    expect(system).toContain('stands on its own');
  });
});
