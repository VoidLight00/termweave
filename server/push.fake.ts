import type { PushPayload } from "../shared/protocol.ts";

/**
 * Test support, never served: a push service on 127.0.0.1 that also plays the browser.
 * It owns one subscription's keys, decrypts every push with an independent RFC 8291
 * (aes128gcm) implementation and verifies the RFC 8292 VAPID signature, so tests assert
 * on the payload a device would actually show - not on what the server meant to send.
 */

export interface ReceivedPush {
  payload: PushPayload;
  urgency: string | null;
  ttl: number;
  /** the JWT verified against the `k=` key it came with */
  vapidValid: boolean;
  vapidKey: string;
  vapidClaims: { aud?: string; sub?: string; exp?: number };
}

export interface FakePushService {
  readonly subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  readonly received: ReceivedPush[];
  /** HTTP status for the next pushes (201 by default; 410 = the device unsubscribed). */
  answerWith(status: number): void;
  waitFor(predicate: (push: ReceivedPush) => boolean, label: string, ms: number): Promise<ReceivedPush>;
  stop(): void;
}

/** WebCrypto takes ArrayBuffer-backed views only. */
type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const base64url = (bytes: Bytes): string => Buffer.from(bytes).toString("base64url");
const fromBase64url = (text: string): Bytes => new Uint8Array(Buffer.from(text, "base64url"));

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

async function decrypt(body: Bytes, privateKey: CryptoKey, publicKey: Bytes, authSecret: Bytes): Promise<string> {
  // header: salt(16) | record size(4) | key id length(1) | key id = sender's public key
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const senderKey = body.slice(21, 21 + idLength);
  const sender = await crypto.subtle.importKey("raw", senderKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(encoder.encode("WebPush: info\0"), publicKey, senderKey), 32);
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + idLength)));
  // a single final record: data, then the 0x02 delimiter, then zero padding
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (plain[end - 1] !== 2) throw new Error("push record is missing its final-record delimiter");
  return new TextDecoder().decode(plain.slice(0, end - 1));
}

async function verifyVapid(header: string | null): Promise<Pick<ReceivedPush, "vapidValid" | "vapidKey" | "vapidClaims">> {
  const match = /^vapid t=([^,\s]+),\s*k=(\S+)$/.exec(header ?? "");
  if (!match) return { vapidValid: false, vapidKey: "", vapidClaims: {} };
  const [, token, key] = match as unknown as [string, string, string];
  const [head, claims, signature] = token.split(".") as [string, string, string];
  const verifier = await crypto.subtle.importKey("raw", fromBase64url(key), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const vapidValid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifier,
    fromBase64url(signature),
    encoder.encode(`${head}.${claims}`),
  );
  return { vapidValid, vapidKey: key, vapidClaims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) };
}

export async function startFakePushService(): Promise<FakePushService> {
  const device = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const devicePublic = new Uint8Array(await crypto.subtle.exportKey("raw", device.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const received: ReceivedPush[] = [];
  const listeners = new Set<(push: ReceivedPush) => void>();
  let answer = 201;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const status = answer;
      if (status >= 200 && status < 300) {
        const push: ReceivedPush = {
          payload: JSON.parse(await decrypt(new Uint8Array(await request.arrayBuffer()), device.privateKey, devicePublic, authSecret)),
          urgency: request.headers.get("urgency"),
          ttl: Number(request.headers.get("ttl")),
          ...(await verifyVapid(request.headers.get("authorization"))),
        };
        received.push(push);
        for (const listener of listeners) listener(push);
      }
      return new Response(null, { status });
    },
  });

  return {
    subscription: {
      endpoint: `http://127.0.0.1:${server.port}/push/${crypto.randomUUID()}`,
      keys: { p256dh: base64url(devicePublic), auth: base64url(authSecret) },
    },
    received,
    answerWith(status) {
      answer = status;
    },
    waitFor(predicate, label, ms) {
      const already = received.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error(`${label} not received within ${ms}ms`));
        }, ms);
        const listener = (push: ReceivedPush) => {
          if (!predicate(push)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(push);
        };
        listeners.add(listener);
      });
    },
    stop() {
      server.stop(true);
    },
  };
}
