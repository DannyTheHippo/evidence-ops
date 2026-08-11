import { Prop, Schema } from '@nestjs/mongoose';
import { Types } from 'mongoose';

// Generic over `_id`'s type, defaulted to `Types.ObjectId` so every existing subclass
// (`extends AuditableDocument`, no type argument) is unaffected. `EvidenceChunk` is the sole
// subclass that supplies `AuditableDocument<string>` — see that schema's own doc comment for why
// its identity is content-addressed rather than a minted ObjectId.
@Schema({ timestamps: true })
export class AuditableDocument<TId = Types.ObjectId> {
  _id: TId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;
}
