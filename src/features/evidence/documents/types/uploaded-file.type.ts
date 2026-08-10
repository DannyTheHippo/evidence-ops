// Subset of multer's `Express.Multer.File` shape used by this feature. Declared locally rather
// than pulled from `@types/multer` — that package isn't installed, multer 2.x ships no bundled
// `.d.ts`, and `@UploadedFile()` returns an untyped parameter, so the annotation below is
// trust-the-runtime either way. A local type avoids a new dependency for a five-field shape.
export interface UploadedFileLike {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}
