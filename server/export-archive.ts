import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'

/** USTAR archive with fixed, application-owned paths and bounded-memory file streaming. */
export async function archiveFiles(directory: string, names: string[], destination: string) {
  function number(header: Buffer, offset: number, length: number, value: number) {
    const octal = value.toString(8)
    if (octal.length < length) header.write(octal.padStart(length - 1, '0') + '\0', offset, length, 'ascii')
    else {
      // GNU/POSIX readers accept base-256 sizes for files larger than 8 GiB.
      let remaining = BigInt(value)
      for (let i = offset + length - 1; i >= offset; i--) { header[i] = Number(remaining & 255n); remaining >>= 8n }
      header[offset] |= 128
    }
  }
  async function* entries() {
    for (const name of names) {
      if (!/^[A-Za-z0-9_./-]{1,99}$/.test(name) || name.includes('..') || name.startsWith('/')) throw new Error('Invalid archive path')
      const file = join(directory, name), info = await stat(file)
      const header = Buffer.alloc(512)
      header.write(name, 0, 100, 'ascii')
      number(header, 100, 8, 0o600); number(header, 108, 8, 0); number(header, 116, 8, 0)
      number(header, 124, 12, info.size); number(header, 136, 12, Math.floor(info.mtimeMs / 1000))
      header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
      header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
      yield header
      for await (const chunk of createReadStream(file)) yield chunk
      const padding = (512 - info.size % 512) % 512
      if (padding) yield Buffer.alloc(padding)
    }
    yield Buffer.alloc(1024)
  }
  await pipeline(Readable.from(entries()), createGzip({ level: 6 }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
}
