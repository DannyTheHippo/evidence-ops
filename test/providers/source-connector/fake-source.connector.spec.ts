import { FakeSourceConnector } from '../../../src/providers/source-connector/fake-source.connector';

describe('FakeSourceConnector', () => {
  let connector: FakeSourceConnector;

  beforeEach(() => {
    connector = new FakeSourceConnector();
  });

  it('should list a seeded file with its size and mtime', async () => {
    connector.addFile('doc.txt', Buffer.from('hello'), 1000);

    const files = await connector.listFiles('');

    expect(files).toEqual([{ relativePath: 'doc.txt', sizeBytes: 5, mtimeMs: 1000 }]);
  });

  it('should list only files whose relativePath starts under the requested prefix', async () => {
    connector.addFile('a/one.txt', Buffer.from('1'));
    connector.addFile('b/two.txt', Buffer.from('2'));

    const files = await connector.listFiles('a');

    expect(files.map((f) => f.relativePath)).toEqual(['a/one.txt']);
  });

  it('should return files sorted by relativePath', async () => {
    connector.addFile('z.txt', Buffer.from('z'));
    connector.addFile('a.txt', Buffer.from('a'));

    const files = await connector.listFiles('');

    expect(files.map((f) => f.relativePath)).toEqual(['a.txt', 'z.txt']);
  });

  it('should fetch the content of a seeded file', async () => {
    connector.addFile('doc.txt', Buffer.from('contents'));

    const buffer = await connector.fetchFile('doc.txt');

    expect(buffer.toString('utf8')).toBe('contents');
  });

  it('should throw when fetching a file that was never seeded', async () => {
    await expect(connector.fetchFile('missing.txt')).rejects.toThrow(/no file/);
  });
});
