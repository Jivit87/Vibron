/**
 * IP literal parsing, CIDR matching and address classification.
 *
 * Pure and dependency-free so the same code runs in rule matching, the
 * SSRF guard and the proxy. IPv6 is held as eight 16-bit groups rather than
 * a BigInt (the project targets ES2017).
 *
 * Callers are expected to hand in hosts that already went through the
 * WHATWG host parser (`normalizeHost`), which folds the odd IPv4 spellings
 * (`0x7f.1`, `2130706433`, `017700000001`) into dotted quads. `parseIPv4`
 * itself is strict: four decimal octets, nothing else.
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  /** IPv4: four octets. IPv6: eight 16-bit groups. */
  parts: number[];
}

export function parseIPv4(input: string): number[] | null {
  const pieces = input.split(".");
  if (pieces.length !== 4) return null;
  const out: number[] = [];
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return null;
    const n = Number(piece);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

export function parseIPv6(input: string): number[] | null {
  let text = input;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // Zone ids (`fe80::1%en0`) do not change which address it is.
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(":")) return null;

  // An embedded dotted-quad tail (`::ffff:127.0.0.1`) is two hex groups.
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const want = 8;
  let groups: number[];
  if (doubleColon !== -1) {
    const head = parseGroups(text.slice(0, doubleColon));
    const rest = parseGroups(text.slice(doubleColon + 2));
    if (!head || !rest) return null;
    const fill = want - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    const all = parseGroups(text);
    if (!all || all.length !== want) return null;
    groups = all;
  }
  return groups.length === 8 ? groups : null;
}

export function parseIp(input: string): ParsedIp | null {
  const v4 = parseIPv4(input);
  if (v4) return { version: 4, parts: v4 };
  const v6 = parseIPv6(input);
  if (v6) return { version: 6, parts: v6 };
  return null;
}

export function isIpLiteral(input: string): boolean {
  return parseIp(input) !== null;
}

/** The IPv4 address an IPv6 one stands in for (mapped, compatible, NAT64). */
export function embeddedIPv4(parts: number[]): number[] | null {
  const zeros = (from: number, to: number) => parts.slice(from, to).every((g) => g === 0);
  const toV4 = () => [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff];
  // ::ffff:a.b.c.d
  if (zeros(0, 5) && parts[5] === 0xffff) return toV4();
  // ::a.b.c.d (deprecated "compatible"); not :: or ::1 themselves.
  if (zeros(0, 6) && (parts[6] !== 0 || parts[7] > 1)) return toV4();
  // 64:ff9b::a.b.c.d (NAT64 well-known prefix)
  if (parts[0] === 0x64 && parts[1] === 0xff9b && zeros(2, 6)) return toV4();
  return null;
}

export interface Cidr {
  version: IpVersion;
  parts: number[];
  prefix: number;
}

export function parseCidr(input: string): Cidr | null {
  const slash = input.lastIndexOf("/");
  if (slash === -1) return null;
  const ip = parseIp(input.slice(0, slash));
  const prefixText = input.slice(slash + 1);
  if (!ip || !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > (ip.version === 4 ? 32 : 128)) return null;
  return { version: ip.version, parts: ip.parts, prefix };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  let target = ip;
  if (cidr.version !== ip.version) {
    // An IPv4 rule also covers the IPv4-mapped spelling of that address.
    if (cidr.version === 4 && ip.version === 6) {
      const v4 = embeddedIPv4(ip.parts);
      if (!v4) return false;
      target = { version: 4, parts: v4 };
    } else {
      return false;
    }
  }
  const width = cidr.version === 4 ? 8 : 16;
  let remaining = cidr.prefix;
  for (let i = 0; i < cidr.parts.length && remaining > 0; i++) {
    const bits = Math.min(width, remaining);
    const mask = ((1 << bits) - 1) << (width - bits);
    if ((cidr.parts[i] & mask) !== (target.parts[i] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

export function ipEquals(a: ParsedIp, b: ParsedIp): boolean {
  const norm = (ip: ParsedIp): ParsedIp => {
    if (ip.version === 6) {
      const v4 = embeddedIPv4(ip.parts);
      if (v4 && ip.parts[5] === 0xffff) return { version: 4, parts: v4 };
    }
    return ip;
  };
  const x = norm(a);
  const y = norm(b);
  return x.version === y.version && x.parts.every((p, i) => p === y.parts[i]);
}

/* ---------------------------- classification ------------------------------ */

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "reserved";

const c = (text: string): Cidr => parseCidr(text) as Cidr;

/**
 * Cloud instance-metadata endpoints. These hand out credentials, so they
 * need an allow rule naming the exact address; a hostname or a range rule
 * is not enough.
 */
export const METADATA_ADDRESSES = [
  "169.254.169.254", // AWS, GCP, Azure, OpenStack, DigitalOcean …
  "169.254.170.2", // AWS ECS task metadata
  "fd00:ec2::254", // AWS IMDS over IPv6
  "100.100.100.200", // Alibaba Cloud
  "168.63.129.16", // Azure WireServer
];
const METADATA = METADATA_ADDRESSES.map((a) => parseIp(a) as ParsedIp);

/** Hostnames that resolve to a metadata service inside the cloud. */
export const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

const V4_RANGES: [Cidr, AddressClass][] = [
  [c("127.0.0.0/8"), "loopback"],
  [c("0.0.0.0/8"), "reserved"],
  [c("10.0.0.0/8"), "private"],
  [c("100.64.0.0/10"), "private"], // carrier-grade NAT
  [c("169.254.0.0/16"), "link-local"],
  [c("172.16.0.0/12"), "private"],
  [c("192.0.0.0/24"), "reserved"],
  [c("192.0.2.0/24"), "reserved"],
  [c("192.168.0.0/16"), "private"],
  [c("198.18.0.0/15"), "reserved"],
  [c("198.51.100.0/24"), "reserved"],
  [c("203.0.113.0/24"), "reserved"],
  [c("224.0.0.0/4"), "reserved"], // multicast
  [c("240.0.0.0/4"), "reserved"], // incl. 255.255.255.255
];

const V6_RANGES: [Cidr, AddressClass][] = [
  [c("::1/128"), "loopback"],
  [c("::/128"), "reserved"],
  [c("fe80::/10"), "link-local"],
  [c("fc00::/7"), "private"], // unique local
  [c("ff00::/8"), "reserved"], // multicast
  [c("2001:db8::/32"), "reserved"], // documentation
];

export function classifyIp(ip: ParsedIp): AddressClass {
  if (METADATA.some((m) => ipEquals(m, ip))) return "metadata";
  if (ip.version === 6) {
    const v4 = embeddedIPv4(ip.parts);
    if (v4) return classifyIp({ version: 4, parts: v4 });
    for (const [range, cls] of V6_RANGES) if (cidrContains(range, ip)) return cls;
    return "public";
  }
  for (const [range, cls] of V4_RANGES) if (cidrContains(range, ip)) return cls;
  return "public";
}

export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) return ip.parts.join(".");
  // Compress the longest zero run, RFC 5952 style.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (ip.parts[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && ip.parts[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = ip.parts.map((p) => p.toString(16));
  if (bestStart === -1) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}
