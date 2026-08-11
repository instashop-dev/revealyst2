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

export interface TeamInviteEmail extends MagicLinkEmail {
  teamName: string;
}

/**
 * Weekly manager digest payload (built by `workers/src/digest.ts`). All text
 * fields are already escaped by the HTML builder — never interpolate raw user
 * content into this email.
 */
export interface WeeklyDigestEmail {
  to: string;
  teamName: string;
  /** e.g. "week ending Jun 16" */
  periodLabel: string;
  avgScore: number | null;
  prevAvgScore: number | null;
  /** this week − last week, null when either window has no data */
  scoreDelta: number | null;
  promptCount: number;
  /** members with events in BOTH windows whose average improved */
  improvedCount: number;
  /** members with events in BOTH windows (the improvement denominator) */
  comparedCount: number;
  /** distinct members active this week */
  activeUsers: number;
  /** human-readable top weakness, e.g. "no output format (34 prompts)" */
  topWeakness: string | null;
  topPrompts: Array<{ title: string | null; score: number | null; usage: number }>;
  dashboardUrl: string;
}

interface EmailTemplate {
  subject: string;
  heading: string;
  body: string;
  cta: string;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildBody(email: MagicLinkEmail, tpl: EmailTemplate): string {
  const safeLink = escapeHtml(email.magicLink);
  // Template fields may contain user input (e.g. the team name in invite
  // emails) — escape them so a crafted team name cannot inject HTML into an
  // email sent from the Revealyst SES identity.
  const heading = escapeHtml(tpl.heading);
  const body = escapeHtml(tpl.body);
  const cta = escapeHtml(tpl.cta);
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
              <h1 style="margin:0 0 12px;font-size:18px;color:#111827;">${heading}</h1>
              <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4b5563;">
                ${body}
              </p>
              <a href="${safeLink}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">
                ${cta}
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
  await sendEmail(config, email, {
    subject: "Your Revealyst sign-in link",
    heading: "Your sign-in link",
    body: "Click the button below to sign in to your Revealyst dashboard. This link is single-use and expires shortly — if you didn't request it, you can safely ignore this email.",
    cta: "Sign in to Revealyst",
  });
}

/**
 * Send a team-invite email (spec §5.8: managers invite members via email).
 * The magic link carries a team_id claim, so verifying it auto-joins the team.
 */
export async function sendTeamInviteEmail(
  config: SesConfig,
  email: TeamInviteEmail,
): Promise<void> {
  await sendEmail(config, email, {
    subject: `${email.teamName} invited you to Revealyst`,
    heading: `You're invited to ${email.teamName} 👋`,
    body: `Your manager invited you to join the ${email.teamName} team on Revealyst. Click below to accept — signing in also adds you to the team, and you can opt into identifiable analytics from your settings. This link is single-use and expires shortly.`,
    cta: "Accept the invite",
  });
}

async function sendRawEmail(
  config: SesConfig,
  email: { to: string; subject: string; html: string },
): Promise<void> {
  const payload = JSON.stringify({
    FromEmailAddress: config.fromEmail,
    Destination: { ToAddresses: [email.to] },
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: { Html: { Data: email.html, Charset: "UTF-8" } },
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
    // Fail fast instead of hanging the magic-link request on a dead endpoint.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`SES send failed (${res.status}): ${detail}`);
  }
}

async function sendEmail(
  config: SesConfig,
  email: MagicLinkEmail,
  tpl: EmailTemplate,
): Promise<void> {
  await sendRawEmail(config, {
    to: email.to,
    subject: tpl.subject,
    html: buildBody(email, tpl),
  });
}

const DIGEST_HEADER = `<!doctype html>
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
            <td style="padding:32px;">`;

const DIGEST_FOOTER = `          </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #f0f0f0;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
                You are receiving this because you are a manager on Revealyst. Sent by Revealyst — turn every prompt into a step forward.
              </p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

/**
 * Build the digest email HTML (exported for unit tests). All user-derived
 * values are HTML-escaped; the layout is a report, not a single-CTA page.
 */
export function buildWeeklyDigestHtml(email: WeeklyDigestEmail): string {
  const escape = escapeHtml;
  const delta =
    email.scoreDelta == null
      ? null
      : `${email.scoreDelta > 0 ? "▲ +" : email.scoreDelta < 0 ? "▼ " : "▬ "}${email.scoreDelta}`;
  const kpi = (label: string, value: string, accent = false) =>
    `<td style="padding:16px;border:1px solid #e5e7eb;border-radius:8px;width:50%;">
       <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.4px;color:#9ca3af;">${escape(label)}</p>
       <p style="margin:0;font-size:24px;font-weight:700;${accent ? "color:#059669;" : "color:#111827;"}">${escape(value)}</p>
     </td>`;

  const topPromptRows =
    email.topPrompts.length === 0
      ? `<p style="margin:0;font-size:13px;color:#6b7280;">No prompts shared to the team library yet — ask members to hit ⭐ on their best prompts.</p>`
      : email.topPrompts
          .map(
            (p, i) =>
              `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#374151;">
                 ${i + 1}. <b>${escape(p.title || "Untitled prompt")}</b>
                 <span style="color:#9ca3af;">— ${p.score == null ? "—" : `${p.score} pts`} · used ${p.usage}×</span>
               </p>`,
          )
          .join("");

  const improvementLine =
    email.comparedCount === 0
      ? `<p style="margin:0;font-size:14px;color:#6b7280;">Not enough data to compare member improvement yet — keep scoring prompts this week.</p>`
      : `<p style="margin:0;font-size:14px;color:#374151;">
           <b>${email.improvedCount} of ${email.comparedCount}</b> members with activity in both weeks improved their average score.
         </p>`;

  return `${DIGEST_HEADER}
<h1 style="margin:0 0 4px;font-size:18px;color:#111827;">Your weekly team digest</h1>
<p style="margin:0 0 24px;font-size:13px;color:#6b7280;">
  ${escape(email.teamName)} · ${escape(email.periodLabel)}
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:0 -8px 8px;">
  <tr>
    ${kpi("Team average PQS", email.avgScore == null ? "—" : String(email.avgScore), true)}
    ${kpi("Prompts scored", String(email.promptCount))}
  </tr>
</table>
${delta == null ? "" : `<p style="margin:0 0 16px;font-size:13px;color:#6b7280;">vs last week: ${delta} pts <span style="color:#9ca3af;">(was ${email.prevAvgScore} pts)</span></p>`}
<p style="margin:0 0 16px;font-size:14px;color:#374151;">${improvementLine}</p>
${email.topWeakness == null ? "" : `<p style="margin:0 0 16px;font-size:14px;color:#374151;">Most common gap: <b>${escape(email.topWeakness)}</b>.</p>`}
<p style="margin:24px 0 8px;font-size:13px;font-weight:600;color:#111827;">Top prompts (team library)</p>
${topPromptRows}
<a href="${escape(email.dashboardUrl)}" style="display:inline-block;margin-top:24px;background:#4f46e5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:8px;">Open the team dashboard</a>
${DIGEST_FOOTER}`;
}

/**
 * Send the weekly manager digest through AWS SES. Subject and HTML are built
 * here; aggregation lives in `workers/src/digest.ts`.
 */
export async function sendWeeklyDigestEmail(
  config: SesConfig,
  email: WeeklyDigestEmail,
): Promise<void> {
  await sendRawEmail(config, {
    to: email.to,
    // SES v2 sends subjects as a JSON field (no header injection possible),
    // but strip control characters so a crafted team name can never smuggle
    // formatting or break the subject line.
    subject: `Revealyst weekly digest — ${email.teamName.replace(/\p{Cc}/gu, " ")}`,
    html: buildWeeklyDigestHtml(email),
  });
}
