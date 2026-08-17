/**
 * `DOCUMENT_STORE` binds to `GridFsDocumentStore`; `FakeDocumentStore` is the test double.
 * `content` is a `Buffer` rather than a stream: callers of this interface work with whole
 * documents, not large-file streaming.
 */
export interface StoredDocument<TMetadata = Record<string, unknown>> {
  readonly id: string;
  readonly content: Buffer;
  readonly contentType: string;
  readonly metadata: TMetadata;
}

export type NewDocument<TMetadata = Record<string, unknown>> = Omit<
  StoredDocument<TMetadata>,
  'id'
>;

export interface DocumentStore {
  put<TMetadata = Record<string, unknown>>(
    doc: NewDocument<TMetadata>,
  ): Promise<StoredDocument<TMetadata>>;
  get(id: string): Promise<StoredDocument | null>;
  delete(id: string): Promise<void>;
}

export const DOCUMENT_STORE = Symbol('DOCUMENT_STORE');
