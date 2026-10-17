/**
 * A small streaming ZIP writer: files are deflated as they are written, so a
 * large table never has to fit in memory. Each entry's sizes and checksum
 * follow its data (a "data descriptor"), which every unzip tool reads.
 *
 * Limits of the classic format, checked rather than worked around: under
 * 65,535 entries and 4 GiB per file and in total (ZIP64 isn't written).
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import zlib from 'node:zlib';

const LIMIT = 0xffff_ffff;

interface Entry { name: Buffer; crc: number; compressed: number; size: number; offset: number; time: number; date: number }

/** DOS date and time, as ZIP stores them */
function dosDateTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  private out: WriteStream;
  private offset = 0;
  private entries: Entry[] = [];

  private failure: Error | null = null;

  constructor(path: string) {
    this.out = createWriteStream(path);
    // A full disk, say: reported by the next write instead of crashing the process
    this.out.on('error', (err) => (this.failure = err));
  }

  private async write(buf: Buffer) {
    if (this.failure) throw this.failure;
    if (!this.out.write(buf)) await once(this.out, 'drain');
    this.offset += buf.length;
    if (this.offset > LIMIT) throw new Error('The export is larger than 4 GiB, which this ZIP writer does not support');
  }

  /** Add a file from text or buffers, written as they arrive */
  async addFile(name: string, content: AsyncIterable<string | Buffer> | Iterable<string | Buffer>, modified = new Date()) {
    if (this.entries.length >= 0xffff) throw new Error('Too many files for one ZIP');
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(modified);
    const offset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // sizes in a data descriptor; UTF-8 name
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // crc and sizes (14..25) left 0: in the data descriptor
    header.writeUInt16LE(nameBuf.length, 26);
    await this.write(header);
    await this.write(nameBuf);

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = zlib.createDeflateRaw({ level: 6 });
    const chunks: Buffer[] = [];
    deflate.on('data', (c: Buffer) => chunks.push(c));
    const flush = async () => {
      while (chunks.length) {
        const c = chunks.shift()!;
        compressed += c.length;
        await this.write(c);
      }
    };
    for await (const part of content) {
      const buf = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
      if (!buf.length) continue;
      crc = zlib.crc32(buf, crc);
      size += buf.length;
      if (size > LIMIT) throw new Error(`${name} is larger than 4 GiB`);
      if (!deflate.write(buf)) await once(deflate, 'drain');
      await flush();
    }
    deflate.end();
    await once(deflate, 'end');
    await flush();

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);
    this.entries.push({ name: nameBuf, crc: crc >>> 0, compressed, size, offset, time, date });
  }

  /** Write the central directory and close the file. Returns its size in bytes. */
  async close(): Promise<number> {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0); // central directory header
      h.writeUInt16LE(20, 4); // made by
      h.writeUInt16LE(20, 6); // needed
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE(e.offset, 42);
      await this.write(h);
      await this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
    await once(this.out, 'finish');
    return this.offset;
  }

  /** Stop and close the file (after a failure; the caller deletes it) */
  abort() {
    this.out.destroy();
  }
}
