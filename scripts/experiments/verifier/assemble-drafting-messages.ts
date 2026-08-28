import type { ModelMessage } from '../../../src/providers/model/model-provider.interface';
import type { CorpusDocument } from './types';

export interface DraftingMessages {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
}

/**
 * The drafting prompt an analyst-voiced pass runs on. It describes writing a memo about one file
 * and nothing else: no mention of checking, of what a downstream tool does with the statements, or
 * of how they will be scored. A prompt that named any of that would make the measured failure rate
 * a property of the prompt's hedging rather than of the tool, which is the one thing this
 * experiment cannot afford — `assemble-drafting-messages.spec.ts` holds that property.
 *
 * One call per document: every statement is about a single file's contents, so the corpus-wide
 * comparisons a reader might also write are outside what this pass produces.
 */
export function assembleDraftingMessages(
  document: CorpusDocument,
  statementCount: number,
): DraftingMessages {
  const system = [
    'You are an analyst writing an internal memo about a company data room. You read one file at a',
    'time and record short factual statements about what it contains.',
    '',
    'Every statement:',
    '- is one plain declarative sentence;',
    '- stands on its own, and reads correctly to someone who does not have the file open;',
    '- names the specific entities, figures, periods and dates the file gives;',
    '- says something a reader of the memo would act on.',
    '',
    'Do not describe the file itself, do not number the statements, and do not repeat a statement',
    'you have already written.',
  ].join('\n');

  const body = document.chunks.map((chunk) => chunk.text).join('\n\n');
  const messages: readonly ModelMessage[] = [
    {
      role: 'user',
      content: `File: ${document.filename}\n\n${body}\n\nWrite ${statementCount} statements about this file.`,
    },
  ];

  return { system, messages };
}
