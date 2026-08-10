import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, WithTimestamps } from 'mongoose';
import { AuditableDocument } from '../../../global/auditable-document/auditable-document.schema';

export type UserDocument = HydratedDocument<WithTimestamps<User>>;

@Schema({ timestamps: true, collection: 'users' })
export class User extends AuditableDocument {
  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true, index: true })
  email: string;

  @Prop({ type: String, required: true })
  password: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
