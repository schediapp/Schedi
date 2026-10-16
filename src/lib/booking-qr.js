// Client-side QR for a booking link. Byte mode, error correction M, versions 1–10.
// No package: the portal inlines this file. Dark modules are 1 in row-major order.

var QR_EXP = new Uint8Array(512);
var QR_LOG = new Uint8Array(256);
(function () {
  var x = 1;
  var i;
  for (i = 0; i < 255; i++) {
    QR_EXP[i] = x;
    QR_LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
})();

function qrMul(a, b) {
  if (!a || !b) return 0;
  return QR_EXP[QR_LOG[a] + QR_LOG[b]];
}

function qrPolyMul(p1, p2) {
  var coeff = new Uint8Array(p1.length + p2.length - 1);
  var i;
  var j;
  for (i = 0; i < p1.length; i++) {
    for (j = 0; j < p2.length; j++) coeff[i + j] ^= qrMul(p1[i], p2[j]);
  }
  return coeff;
}

function qrPolyMod(divident, divisor) {
  var result = new Uint8Array(divident);
  var offset;
  var i;
  var coeff;
  while (result.length - divisor.length >= 0) {
    coeff = result[0];
    for (i = 0; i < divisor.length; i++) result[i] ^= qrMul(divisor[i], coeff);
    offset = 0;
    while (offset < result.length && result[offset] === 0) offset++;
    result = result.slice(offset);
  }
  return result;
}

function qrRs(data, ecLen) {
  var poly = new Uint8Array([1]);
  var i;
  var padded;
  var remainder;
  var start;
  var out;
  for (i = 0; i < ecLen; i++) poly = qrPolyMul(poly, new Uint8Array([1, QR_EXP[i]]));
  padded = new Uint8Array(data.length + ecLen);
  padded.set(data);
  remainder = qrPolyMod(padded, poly);
  start = ecLen - remainder.length;
  if (start > 0) {
    out = new Uint8Array(ecLen);
    out.set(remainder, start);
    return out;
  }
  return remainder;
}

var QR_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
var QR_EC_BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
var QR_EC_WORDS_M = [0, 10, 16, 26, 36, 48, 64, 72, 88, 110, 130];

function qrBitLen(n) {
  var bits = 0;
  while (n) {
    bits++;
    n >>>= 1;
  }
  return bits;
}

function qrFormatBits(mask) {
  var data = mask;
  var d = data << 10;
  var g = 0x537;
  var gBits = 11;
  while (qrBitLen(d) - gBits >= 0) d ^= g << (qrBitLen(d) - gBits);
  return ((data << 10) | d) ^ 0x5412;
}

function qrVersionBits(version) {
  var d = version << 12;
  var g = 0x1f25;
  while (qrBitLen(d) - 13 >= 0) d ^= g << (qrBitLen(d) - 13);
  return (version << 12) | d;
}

function qrBytes(text) {
  var raw = String(text || '');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(raw);
  var out = [];
  var i;
  for (i = 0; i < raw.length; i++) out.push(raw.charCodeAt(i) & 255);
  return out;
}

function qrVersionFor(len) {
  var version;
  var dataWords;
  var countBits;
  var usable;
  for (version = 1; version <= 10; version++) {
    dataWords = QR_CODEWORDS[version] - QR_EC_WORDS_M[version];
    countBits = version < 10 ? 8 : 16;
    usable = dataWords * 8 - 4 - countBits;
    if (Math.floor(usable / 8) >= len) return version;
  }
  return 0;
}

function qrPush(bits, value, length) {
  var i;
  for (i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function qrDataCodewords(bytes, version) {
  var bits = [];
  var dataWords = QR_CODEWORDS[version] - QR_EC_WORDS_M[version];
  var countBits = version < 10 ? 8 : 16;
  var i;
  var byte = 0;
  var bit = 0;
  var out;
  qrPush(bits, 0x4, 4);
  qrPush(bits, bytes.length, countBits);
  for (i = 0; i < bytes.length; i++) qrPush(bits, bytes[i], 8);
  for (i = 0; i < 4 && bits.length < dataWords * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  out = [];
  for (i = 0; i < bits.length; i++) {
    byte = (byte << 1) | bits[i];
    bit++;
    if (bit === 8) {
      out.push(byte);
      byte = 0;
      bit = 0;
    }
  }
  i = 0;
  while (out.length < dataWords) {
    out.push(i % 2 ? 0x11 : 0xec);
    i++;
  }
  return out;
}

function qrInterleave(codewords, version) {
  var total = QR_CODEWORDS[version];
  var ecTotal = QR_EC_WORDS_M[version];
  var dataTotal = total - ecTotal;
  var blocks = QR_EC_BLOCKS_M[version];
  var group2 = total % blocks;
  var group1 = blocks - group2;
  var data1 = Math.floor(dataTotal / blocks);
  var data2 = data1 + 1;
  var ecLen = Math.floor(total / blocks) - data1;
  var dc = [];
  var ec = [];
  var offset = 0;
  var b;
  var size;
  var max = 0;
  var out = new Uint8Array(total);
  var index = 0;
  var i;
  var r;
  for (b = 0; b < blocks; b++) {
    size = b < group1 ? data1 : data2;
    dc.push(Uint8Array.from(codewords.slice(offset, offset + size)));
    ec.push(qrRs(dc[b], ecLen));
    offset += size;
    if (size > max) max = size;
  }
  for (i = 0; i < max; i++) {
    for (r = 0; r < blocks; r++) {
      if (i < dc[r].length) out[index++] = dc[r][i];
    }
  }
  for (i = 0; i < ecLen; i++) {
    for (r = 0; r < blocks; r++) out[index++] = ec[r][i];
  }
  return out;
}

function qrAlignPos(version) {
  if (version === 1) return [];
  var size = version * 4 + 17;
  var count = Math.floor(version / 7) + 2;
  var step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * count - 2)) * 2;
  var pos = [size - 7];
  var i;
  var j;
  var coords = [];
  for (i = 1; i < count - 1; i++) pos[i] = pos[i - 1] - step;
  pos.push(6);
  pos.reverse();
  for (i = 0; i < pos.length; i++) {
    for (j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      coords.push([pos[i], pos[j]]);
    }
  }
  return coords;
}

function qrMaskAt(pattern, row, col) {
  if (pattern === 0) return (row + col) % 2 === 0;
  if (pattern === 1) return row % 2 === 0;
  if (pattern === 2) return col % 3 === 0;
  if (pattern === 3) return (row + col) % 3 === 0;
  if (pattern === 4) return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
  if (pattern === 5) return (row * col) % 2 + (row * col) % 3 === 0;
  if (pattern === 6) return ((row * col) % 2 + (row * col) % 3) % 2 === 0;
  return ((row * col) % 3 + (row + col) % 2) % 2 === 0;
}

function qrPenalty(dark, size) {
  var points = 0;
  var row;
  var col;
  var sameRow;
  var sameCol;
  var lastRow;
  var lastCol;
  var module;
  var last;
  var bitsRow;
  var bitsCol;
  var darkCount = 0;
  var i;
  var k;
  for (row = 0; row < size; row++) {
    sameRow = 0;
    sameCol = 0;
    lastRow = -1;
    lastCol = -1;
    for (col = 0; col < size; col++) {
      module = dark[row * size + col];
      if (module === lastCol) sameCol++;
      else {
        if (sameCol >= 5) points += 3 + (sameCol - 5);
        lastCol = module;
        sameCol = 1;
      }
      module = dark[col * size + row];
      if (module === lastRow) sameRow++;
      else {
        if (sameRow >= 5) points += 3 + (sameRow - 5);
        lastRow = module;
        sameRow = 1;
      }
    }
    if (sameCol >= 5) points += 3 + (sameCol - 5);
    if (sameRow >= 5) points += 3 + (sameRow - 5);
  }
  for (row = 0; row < size - 1; row++) {
    for (col = 0; col < size - 1; col++) {
      last = dark[row * size + col] + dark[row * size + col + 1] + dark[(row + 1) * size + col] + dark[(row + 1) * size + col + 1];
      if (last === 0 || last === 4) points += 3;
    }
  }
  for (row = 0; row < size; row++) {
    bitsCol = 0;
    bitsRow = 0;
    for (col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | dark[row * size + col];
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 40;
      bitsRow = ((bitsRow << 1) & 0x7ff) | dark[col * size + row];
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 40;
    }
  }
  for (i = 0; i < dark.length; i++) darkCount += dark[i];
  k = Math.abs(Math.ceil((darkCount * 100 / dark.length) / 5) - 10);
  return points + k * 10;
}

function schediQrModules(text) {
  var bytes = qrBytes(text);
  var version = qrVersionFor(bytes.length);
  var size;
  var dark;
  var reserved;
  var codewords;
  var data;
  var align;
  var i;
  var r;
  var c;
  var row;
  var col;
  var bits;
  var mod;
  var pattern;
  var best;
  var bestScore;
  var score;
  var snapshot;
  var masked;
  function set(rr, cc, value, lock) {
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return;
    dark[rr * size + cc] = value ? 1 : 0;
    if (lock) reserved[rr * size + cc] = 1;
  }
  if (!version || bytes.length > 213) return null;
  size = version * 4 + 17;
  dark = new Uint8Array(size * size);
  reserved = new Uint8Array(size * size);
  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (origin) {
    for (r = -1; r <= 7; r++) {
      for (c = -1; c <= 7; c++) {
        if ((r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) set(origin[0] + r, origin[1] + c, 1, 1);
        else set(origin[0] + r, origin[1] + c, 0, 1);
      }
    }
  });
  for (r = 8; r < size - 8; r++) {
    set(r, 6, r % 2 === 0, 1);
    set(6, r, r % 2 === 0, 1);
  }
  align = qrAlignPos(version);
  for (i = 0; i < align.length; i++) {
    for (r = -2; r <= 2; r++) {
      for (c = -2; c <= 2; c++) {
        set(align[i][0] + r, align[i][1] + c, r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0), 1);
      }
    }
  }
  function paintFormat(mask) {
    var format = qrFormatBits(mask);
    var n;
    var on;
    for (n = 0; n < 15; n++) {
      on = ((format >> n) & 1) === 1;
      if (n < 6) set(n, 8, on, 1);
      else if (n < 8) set(n + 1, 8, on, 1);
      else set(size - 15 + n, 8, on, 1);
      if (n < 8) set(8, size - n - 1, on, 1);
      else if (n < 9) set(8, 15 - n, on, 1);
      else set(8, 15 - n - 1, on, 1);
    }
    set(size - 8, 8, 1, 1);
  }
  paintFormat(0);
  if (version >= 7) {
    bits = qrVersionBits(version);
    for (i = 0; i < 18; i++) {
      row = Math.floor(i / 3);
      col = i % 3 + size - 11;
      mod = ((bits >> i) & 1) === 1;
      set(row, col, mod, 1);
      set(col, row, mod, 1);
    }
  }
  codewords = qrDataCodewords(bytes, version);
  data = qrInterleave(codewords, version);
  row = size - 1;
  c = -1;
  i = 0;
  bits = 7;
  for (col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (r = 0; r < 2; r++) {
        if (!reserved[row * size + (col - r)]) {
          mod = 0;
          if (i < data.length) mod = (data[i] >>> bits) & 1;
          dark[row * size + (col - r)] = mod;
          bits--;
          if (bits < 0) {
            i++;
            bits = 7;
          }
        }
      }
      row += c;
      if (row < 0 || row >= size) {
        row -= c;
        c = -c;
        break;
      }
    }
  }
  snapshot = dark.slice();
  best = 0;
  bestScore = Infinity;
  for (pattern = 0; pattern < 8; pattern++) {
    masked = snapshot.slice();
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        if (reserved[r * size + c]) continue;
        if (qrMaskAt(pattern, r, c)) masked[r * size + c] ^= 1;
      }
    }
    paintFormat(pattern);
    for (i = 0; i < reserved.length; i++) if (reserved[i]) masked[i] = dark[i];
    score = qrPenalty(masked, size);
    if (score < bestScore) {
      bestScore = score;
      best = pattern;
    }
  }
  dark = snapshot.slice();
  for (r = 0; r < size; r++) {
    for (c = 0; c < size; c++) {
      if (reserved[r * size + c]) continue;
      if (qrMaskAt(best, r, c)) dark[r * size + c] ^= 1;
    }
  }
  paintFormat(best);
  return { size: size, dark: dark, version: version, mask: best };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { schediQrModules: schediQrModules };
