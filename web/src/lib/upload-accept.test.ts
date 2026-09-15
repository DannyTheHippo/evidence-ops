import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_SIZE_BYTES, precheckUploadFile } from './upload-accept';

function makeFile(name: string, size = 1024): { name: string; size: number } {
  return { name, size };
}

describe('precheckUploadFile', () => {
  it('accepts an allowlisted extension', () => {
    expect(precheckUploadFile(makeFile('report.pdf'))).toBeNull();
  });

  it('accepts .htm', () => {
    expect(precheckUploadFile(makeFile('page.htm'))).toBeNull();
  });

  it('accepts .HTML case-insensitively', () => {
    expect(precheckUploadFile(makeFile('page.HTML'))).toBeNull();
  });

  it('rejects an unlisted extension', () => {
    expect(precheckUploadFile(makeFile('installer.exe'))).toBe('Unsupported file type.');
  });

  it('rejects a filename with no extension at all', () => {
    expect(precheckUploadFile(makeFile('README'))).toBe('Unsupported file type.');
  });

  it('rejects a file over the size cap', () => {
    const file = makeFile('report.pdf', MAX_UPLOAD_SIZE_BYTES + 1);
    expect(precheckUploadFile(file)).toBe('File exceeds the 50 MB limit.');
  });

  it('accepts a file at exactly the size cap', () => {
    const file = makeFile('report.pdf', MAX_UPLOAD_SIZE_BYTES);
    expect(precheckUploadFile(file)).toBeNull();
  });
});
