// Builds a valid PNG in memory so the crop specs need no binary fixtures in the repo.
// Deliberately not square and not grey: the crop assertions have to be able to tell the output
// apart from the input, and a portrait source is the case the server currently mangles.
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

// `detail` controls how much high-frequency content the image has, which is what Laplacian
// variance measures: 'sharp' produces a fine checkerboard (high variance), 'blur' a smooth
// gradient (near-zero variance). `luma` shifts the whole image brighter or darker for the
// exposure checks.
export function makePng (width, height, options = {}) {
  const { detail = 'gradient', luma = null } = options
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour RGB
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // Horizontal/vertical gradient, so a crop of one corner is visibly different from another.
  const raw = Buffer.alloc(height * (1 + width * 3))
  let pos = 0
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      let r, g, b
      if (luma !== null) {
        r = g = b = luma
      } else if (detail === 'sharp') {
        // 2px checkerboard: maximum edge energy at every pixel boundary.
        const on = ((x >> 1) + (y >> 1)) % 2 === 0
        r = g = b = on ? 245 : 10
      } else if (detail === 'blur') {
        // A very smooth ramp: almost no local contrast, so the Laplacian response stays near 0.
        r = g = b = 100 + Math.floor((x / width) * 20)
      } else {
        r = Math.floor((x / width) * 255)
        g = Math.floor((y / height) * 255)
        b = 128
      }
      raw[pos++] = r
      raw[pos++] = g
      raw[pos++] = b
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
