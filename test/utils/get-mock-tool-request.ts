import { z } from 'zod/v4';
import type {
  ModelRequest,
  ModelToolDefinition,
} from '../../src/providers/model/model-provider.interface';

/** Shared by `anthropic-model.provider.spec.ts` and `openai-model.provider.spec.ts` so each
 * provider's "same neutral input maps to my vendor's own shape" assertion runs against the
 * literal same object, not two hand-copied lookalikes. */
export const mockToolDefinition: ModelToolDefinition = {
  name: 'lookup_price',
  description: 'Looks up the current price for a stock ticker.',
  inputSchema: z.object({ ticker: z.string() }),
};

export function getMockToolRequest(): ModelRequest<undefined> {
  return {
    taskClass: 'qa_answer',
    messages: [
      { role: 'user', content: 'What is the price of ACME?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'lookup_price', input: { ticker: 'ACME' } }],
      },
      { role: 'tool', content: '259.75 USD', toolCallId: 'call_1' },
    ],
    maxTokens: 100,
    maxCostUsd: 1,
    tools: [mockToolDefinition],
    toolChoice: 'auto',
  };
}
