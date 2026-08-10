import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Connection, mongo } from 'mongoose';
import type { DocumentStore, NewDocument, StoredDocument } from './document-store.interface';

const BUCKET_NAME = 'documents';

/**
 * GridFS has no first-class `contentType` field on the files collection any more (only
 * `metadata`), so `NewDocument.contentType` is folded into `metadata.contentType` on write and
 * split back out on read — the one place `DocumentStore`'s shape doesn't map onto GridFS 1:1.
 */
@Injectable()
export class GridFsDocumentStore implements DocumentStore {
  private readonly bucket: mongo.GridFSBucket;

  constructor(@InjectConnection() connection: Connection) {
    // `@nestjs/mongoose`'s MongooseCoreModule resolves the `Connection` provider from
    // `connection.asPromise()`, so `connection.db` is always set by the time any consumer of
    // `@InjectConnection()` is constructed — the `| undefined` in the driver's type is a static
    // artifact of `Connection` being usable before `asPromise()` resolves, which never happens
    // here. Fails CLOSED rather than trusting that invariant silently: a store that can't reach
    // its database must refuse to construct, not hand back a store that fails on every call.
    if (!connection.db) {
      throw new Error('Mongo connection has no active database handle');
    }

    this.bucket = new mongo.GridFSBucket(connection.db, { bucketName: BUCKET_NAME });
  }

  async put<TMetadata = Record<string, unknown>>(
    doc: NewDocument<TMetadata>,
  ): Promise<StoredDocument<TMetadata>> {
    // `metadata` nests `doc.metadata` under its own key rather than spreading it alongside
    // `contentType`: `TMetadata` carries no `object` constraint on the interface, so spreading an
    // unconstrained generic isn't type-safe. Nesting sidesteps that without a cast.
    const id = await new Promise<mongo.ObjectId>((resolve, reject) => {
      const uploadStream = this.bucket.openUploadStream(randomUUID(), {
        metadata: { contentType: doc.contentType, metadata: doc.metadata },
      });
      uploadStream.once('error', reject);
      uploadStream.end(doc.content, () => resolve(uploadStream.id));
    });

    return { id: id.toString(), ...doc };
  }

  async get(id: string): Promise<StoredDocument | null> {
    if (!mongo.ObjectId.isValid(id)) {
      return null;
    }
    const objectId = new mongo.ObjectId(id);

    const [file] = await this.bucket.find({ _id: objectId }).toArray();
    if (!file) {
      return null;
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      this.bucket
        .openDownloadStream(objectId)
        .on('data', (chunk: Buffer) => chunks.push(chunk))
        .once('error', reject)
        .once('end', resolve);
    });

    const stored = (file.metadata ?? {}) as { contentType?: unknown; metadata?: unknown };
    const contentType =
      typeof stored.contentType === 'string' ? stored.contentType : 'application/octet-stream';
    const metadata = (stored.metadata ?? {}) as Record<string, unknown>;

    return {
      id,
      content: Buffer.concat(chunks),
      contentType,
      metadata,
    };
  }

  async delete(id: string): Promise<void> {
    if (!mongo.ObjectId.isValid(id)) {
      return;
    }
    const objectId = new mongo.ObjectId(id);

    // Mirrors `FakeDocumentStore.delete`, which no-ops on a missing key: `bucket.delete()` throws
    // on an unknown id, so existence is checked first to keep this call idempotent like the fake.
    const exists = await this.bucket.find({ _id: objectId }).limit(1).next();
    if (!exists) {
      return;
    }

    await this.bucket.delete(objectId);
  }
}
