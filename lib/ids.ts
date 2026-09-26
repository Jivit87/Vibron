// Pure JavaScript SHA-1 implementation to be browser-safe and server-safe
// without importing Node.js "crypto" in the browser bundle.
export function sha1(str: string): string {
  let h0 = 0x67452301;
  let h1 = 0xEFCDAB89;
  let h2 = 0x98BADCFE;
  let h3 = 0x10325476;
  let h4 = 0xC3D2E1F0;

  // Convert to UTF-8 byte array
  const utf8: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let charcode = str.charCodeAt(i);
    if (charcode < 0x80) {
      utf8.push(charcode);
    } else if (charcode < 0x800) {
      utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
    } else if (charcode < 0xd800 || charcode >= 0xe000) {
      utf8.push(0xe0 | (charcode >> 12), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
    } else {
      i++;
      charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      utf8.push(0xf0 | (charcode >> 18), 0x80 | ((charcode >> 12) & 0x3f), 0x80 | ((charcode >> 6) & 0x3f), 0x80 | (charcode & 0x3f));
    }
  }

  const l = utf8.length;
  utf8.push(0x80);
  while ((utf8.length + 8) % 64 !== 0) {
    utf8.push(0);
  }
  
  // Length in bits as 64-bit big-endian
  const bits = l * 8;
  const lenBytes = new Array(8);
  for (let i = 0; i < 8; i++) {
    lenBytes[7 - i] = (bits >>> (i * 8)) & 0xff;
  }
  utf8.push(...lenBytes);

  const w = new Uint32Array(80);
  for (let offset = 0; offset < utf8.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] = (utf8[idx] << 24) | (utf8[idx + 1] << 16) | (utf8[idx + 2] << 8) | utf8[idx + 3];
    }
    for (let i = 16; i < 80; i++) {
      const val = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (val << 1) | (val >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5A827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }

      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const toHex = (num: number) => {
    const s = (num >>> 0).toString(16);
    return "00000000".slice(s.length) + s;
  };
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

export function repoKey(repoRef: string): string {
  return sha1(repoRef).slice(0, 16);
}

export function nodeId(file: string, name: string, startLine: number): string {
  return sha1(`${file}:${name}:${startLine}`).slice(0, 16);
}
