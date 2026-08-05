import { Buffer } from "node:buffer";

const encoder = new TextEncoder();

/**
 * AES-256-GCM prompt-library encryption at rest (spec §5.7). The blob is
 * hex-encoded (iv || ciphertext) so it round-trips through any SQL transport;
 * the key is derived by SHA-256 hashing the secret key material.
 */
export async function encryptPrompt(plaintext: string, keyMaterial: string): Promise<string> {
  const key = await deriveKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return Buffer.concat([Buffer.from(iv), Buffer.from(ciphertext)]).toString("hex");
}

export async function decryptPrompt(hexBlob: string, keyMaterial: string): Promise<string> {
  const key = await deriveKey(keyMaterial);
  const blob = Buffer.from(hexBlob, "hex");
  const iv = new Uint8Array(blob.subarray(0, 12));
  const ciphertext = new Uint8Array(blob.subarray(12));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function deriveKey(keyMaterial: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(keyMaterial));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** SHA-256 hex digest — used to hash prompt text before it leaves the device. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
