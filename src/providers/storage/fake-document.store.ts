import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DocumentStore, NewDocument, StoredDocument } from './document-store.interface';

/** Test double: in-memory `Map`, no persistence across instances. */
@Injectable()
export class FakeDocumentStore implements DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async put<TMetadata = Record<string, unknown>>(
    doc: NewDocument<TMetadata>,
  ): Promise<StoredDocument<TMetadata>> {
    const stored: StoredDocument<TMetadata> = { id: randomUUID(), ...doc };
    this.documents.set(stored.id, stored as StoredDocument);
    return stored;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async get(id: string): Promise<StoredDocument | null> {
    return this.documents.get(id) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async; the fake resolves synchronously
  async delete(id: string): Promise<void> {
    this.documents.delete(id);
  }
}
