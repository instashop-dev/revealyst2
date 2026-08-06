/**
 * Transactional email via AWS SES (API v2 / SendEmail).
 *
 * Zero-dependency: signs the request with AWS Signature V4 using the Web
 * Crypto API (HMAC-SHA256), so it runs on Cloudflare Workers without an SDK.
 *
 * Endpoint: POST https://email.<region>.amazonaws.com/v2/email/outbound-emails
 */

export interface SesConfig {
  /** AWS region hosting the SES endpoint, e.g. "us-east-1". */
  region: string;
  /** AWS access key ID (Worker secret). */
  accessKeyId: string;
  /** AWS secret access key (Worker secret). */
  secretAccessKey: string;
  /** Verified sender, e.g. `Revealyst <noreply@e.revealyst.com>`. */
  fromEmail: string;
}

export interface MagicLinkEmail {
  to: string;
  magicLink: string;
}

const SES_SERVICE = "ses";
const SES_HOST = (region: string) => `email.${region}.amazonaws.com`;

const enc = new TextEncoder();

async function hmac(
  key: ArrayBuffer | Uint8Array,
  data: string | Uint8Array,
): Promise<ArrayBuffer> {
  const keyBuf = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    (typeof data === "string" ? enc.encode(data) : data) as BufferSource,
  );
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    (typeof data === "string" ? enc.encode(data) : data) as BufferSource,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `20260806T034512Z` from a Date. */
export function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function toDateStamp(amzDate: string): string {
  return amzDate.slice(0, 8);
}

/**
 * Build the `Authorization` header value for an AWS SigV4 request.
 * Exported for unit testing against the AWS SigV4 test vectors.
 */
export async function signRequest(params: {
  method: string;
  host: string;
  path: string;
  /** Canonical query string (sorted, encoded) — empty for SES. */
  query: string;
  headers: Record<string, string>;
  payload: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
  /** Exclude x-amz-content-sha256 (not required by all services; used to match the official SigV4 test vectors). */
  excludeContentSha?: boolean;
}): Promise<{ authorization: string; amzDate: string; payloadHash: string }> {
  const { method, host, path, query, headers, payload } = params;
  const amzDate = toAmzDate(params.date);
  const dateStamp = toDateStamp(amzDate);
  const payloadHash = await sha256Hex(payload);

  const allHeaders: Record<string, string> = {
    host,
    ...(params.excludeContentSha ? {} : { "x-amz-content-sha256": payloadHash }),
    "x-amz-date": amzDate,
    ...headers,
  };
  const signedHeaderNames = Object.keys(allHeaders)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${(allHeaders[h] ?? "").trim()}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );
  const canonicalRequestHash = await sha256Hex(canonicalRequest);

  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, canonicalRequestHash].join(
    "\n",
  );

  const kDate = await hmac(enc.encode(`AWS4${params.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, params.region);
  const kService = await hmac(kRegion, params.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDate, payloadHash };
}

function buildBody(email: MagicLinkEmail): string {
  const safeLink = email.magicLink
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px;background:linear-gradient(135deg,#4f46e5,#7c3aed);">
              <span style="color:#ffffff;font-size:20px;font-weight:700;">Revealyst</span>
              <span style="color:#c7d2fe;font-size:13px;display:block;margin-top:2px;">Turn every prompt into a step forward.</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 12px;font-size:18px;color:#111827;">Your sign-in link</h1>
              <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5563;">
                Click the button below to sign in to your Revealyst dashboard. This link
                is single-use and expires shortly — if you didn't request it, you can
                safely ignore this email.
              </p>
              <a href="${safeLink}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">
                Sign in to Revealyst
              </a>
              <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#9ca3af;word-break:break-all;">
                Or paste this link into your browser:<br />${safeLink}
              </p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

/**
 * Send a magic-link email through AWS SES.
 *
 * @throws Error with a human-readable reason if SES rejects the send.
 */
export async function sendMagicLinkEmail(config: SesConfig, email: MagicLinkEmail): Promise<void> {
  const payload = JSON.stringify({
    FromEmailAddress: config.fromEmail,
    Destination: { ToAddresses: [email.to] },
    Content: {
      Simple: {
        Subject: { Data: "Your Revealyst sign-in link", Charset: "UTF-8" },
        Body: { Html: { Data: buildBody(email), Charset: "UTF-8" } },
      },
    },
  });

  const host = SES_HOST(config.region);
  const path = "/v2/email/outbound-emails";
  const date = new Date();
  const { authorization, amzDate, payloadHash } = await signRequest({
    method: "POST",
    host,
    path,
    query: "",
    headers: {},
    payload,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: SES_SERVICE,
    date,
  });

  const res = await fetch(`https://${host}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      Authorization: authorization,
    },
    body: payload,
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`SES send failed (${res.status}): ${detail}`);
  }
}
