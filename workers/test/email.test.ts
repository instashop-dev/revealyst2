import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMagicLinkEmail, signRequest, toAmzDate, toDateStamp } from "../src/email.js";

// Official AWS SigV4 test suite — "get-vanilla"
// https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html
const AWS_VECTOR = {
  method: "GET",
  host: "example.amazonaws.com",
  path: "/",
  query: "",
  headers: {},
  payload: "",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  date: new Date("2015-08-30T12:36:00Z"),
  expectedSignature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
};

/** Independent SigV4 reference implementation (node:crypto) per AWS docs. */
async function referenceSigV4(params: {
  method: string;
  host: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  payload: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
}): Promise<string> {
  const hmac = (key: string | Buffer, data: string | Buffer) =>
    createHmac("sha256", key).update(data).digest();
  const sha256hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

  const amzDate = params.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(params.payload);

  const allHeaders: Record<string, string> = {
    host: params.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...params.headers,
  };
  const names = Object.keys(allHeaders)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((h) => `${h}:${(allHeaders[h] ?? "").trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    params.method,
    params.path,
    params.query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, params.region);
  const kService = hmac(kRegion, params.service);
  const kSigning = hmac(kService, "aws4_request");
  return hmac(kSigning, stringToSign).toString("hex");
}

describe("SigV4 signer", () => {
  it("matches the official AWS get-vanilla test vector", async () => {
    const { authorization, amzDate } = await signRequest({
      ...AWS_VECTOR,
      excludeContentSha: true,
    });
    expect(amzDate).toBe("20150830T123600Z");
    expect(authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ` +
        `SignedHeaders=host;x-amz-date, Signature=${AWS_VECTOR.expectedSignature}`,
    );
  });

  it("agrees with an independent reference implementation for a POST with body", async () => {
    const params = {
      method: "POST",
      host: "email.us-east-1.amazonaws.com",
      path: "/v2/email/outbound-emails",
      query: "",
      headers: {},
      payload: JSON.stringify({ FromEmailAddress: "Revealyst <noreply@e.revealyst.com>" }),
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "ses",
      date: new Date("2026-08-06T03:45:12Z"),
    };
    const expectedSig = await referenceSigV4(params);
    const { authorization } = await signRequest(params);
    expect(authorization).toContain(`SignedHeaders=host;x-amz-content-sha256;x-amz-date`);
    expect(authorization).toContain(`Signature=${expectedSig}`);
  });

  it("formats amz dates", () => {
    expect(toAmzDate(new Date("2015-08-30T12:36:00Z"))).toBe("20150830T123600Z");
    expect(toDateStamp("20150830T123600Z")).toBe("20150830");
  });
});

describe("sendMagicLinkEmail", () => {
  const config = {
    region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    fromEmail: "Revealyst <noreply@e.revealyst.com>",
  };

  afterEach(() => vi.unstubAllGlobals());

  it("sends a properly signed SESv2 request", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ MessageId: "m-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendMagicLinkEmail(config, {
      to: "user@example.com",
      magicLink: "https://revealyst-web.pages.dev/auth/verify?token=abc123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");

    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["X-Amz-Date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers["X-Amz-Content-Sha256"]).toMatch(/^[0-9a-f]{64}$/);

    const body = JSON.parse(init.body as string);
    expect(body.FromEmailAddress).toBe(config.fromEmail);
    expect(body.Destination.ToAddresses).toEqual(["user@example.com"]);
    expect(body.Content.Simple.Subject.Data).toContain("Revealyst");
    expect(body.Content.Simple.Body.Html.Data).toContain(
      "https://revealyst-web.pages.dev/auth/verify?token=abc123",
    );
  });

  it("throws a descriptive error when SES rejects the send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "FromEmailAddress identity not verified" }), {
            status: 400,
          }),
      ),
    );
    await expect(
      sendMagicLinkEmail(config, { to: "user@example.com", magicLink: "https://x.dev/l" }),
    ).rejects.toThrow(/SES send failed \(400\)/);
  });
});
