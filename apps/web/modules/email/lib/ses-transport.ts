import { SESv2Client, type SESv2ClientConfig, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createTransport } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type SESTransport from "nodemailer/lib/ses-transport";
import { SES_CONFIGURATION_SET, SES_EMAIL_ENVIRONMENT, SES_REGION } from "@/lib/constants";

/** The part of `SESv2Client` the nodemailer SES transport calls; a test passes a fake. */
export type TSesClient = SESTransport.SESv2ClientLike;

/**
 * One retry, and short timeouts, so a slow or unreachable SES endpoint fails a send in seconds instead of
 * holding the request open. `throwOnRequestTimeout` is required: without it the handler only logs a
 * warning when `requestTimeout` is exceeded. No `endpoint` (so `AWS_ENDPOINT_URL_SESV2` still applies)
 * and no static keys: credentials come from the default chain, such as a container task role.
 */
export const getSesClientConfig = (): SESv2ClientConfig => ({
  region: SES_REGION,
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 1000, requestTimeout: 3000, throwOnRequestTimeout: true },
});

let sesClient: SESv2Client | undefined;

/** Created on first use and reused, so sends share the client's keep-alive connections. */
export const getSesClient = (): SESv2Client => {
  sesClient ??= new SESv2Client(getSesClientConfig());
  return sesClient;
};

/** Drops the cached client, so a test can observe how the next one is built. */
export const resetSesClientForTests = (): void => {
  sesClient = undefined;
};

/**
 * Configuration set and tags for one message. Same condition and the same two tags as the SMTP path's
 * `X-SES-CONFIGURATION-SET` / `X-SES-MESSAGE-TAGS` headers, so SES event publishing sees no difference.
 */
export const getSesMessageOptions = (emailType: string): Pick<Mail.Options, "ses"> =>
  SES_CONFIGURATION_SET && SES_EMAIL_ENVIRONMENT
    ? {
        ses: {
          ConfigurationSetName: SES_CONFIGURATION_SET,
          EmailTags: [
            { Name: "email_type", Value: emailType },
            { Name: "environment", Value: SES_EMAIL_ENVIRONMENT },
          ],
        },
      }
    : {};

/** A nodemailer transport over the SES v2 `SendEmail` API. nodemailer's own logging stays off. */
export const createSesTransport = (client: TSesClient = getSesClient()) =>
  createTransport({ SES: { sesClient: client, SendEmailCommand }, logger: false, debug: false });

/**
 * Sends one message through SES. Returns only the SES MessageId, as `serverMessageId` (what the send audit
 * reads), and never nodemailer's info object, which also carries the envelope and the raw message.
 */
export const sendEmailWithSes = async (
  message: Mail.Options,
  emailType: string,
  client?: TSesClient
): Promise<{ serverMessageId: string }> => {
  const info = await createSesTransport(client).sendMail({ ...message, ...getSesMessageOptions(emailType) });
  return { serverMessageId: info.response };
};

export type TSesErrorClass = "throttled" | "rejected" | "auth" | "timeout" | "network" | "server" | "unknown";

const throttledNames = new Set([
  "TooManyRequestsException",
  "ThrottlingException",
  "Throttling",
  "LimitExceededException",
]);
const authNames = new Set([
  "AccessDeniedException",
  "AccessDenied",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "MissingAuthenticationTokenException",
  "CredentialsProviderError",
]);
const rejectedNames = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "BadRequestException",
  "NotFoundException",
  "AccountSuspendedException",
  "SendingPausedException",
]);
const timeoutNames = new Set(["TimeoutError", "RequestTimeout", "RequestTimeoutException", "AbortError"]);
const timeoutCodes = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);
const networkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * A fixed, low-cardinality class for a failed SES send, for logs and metrics. Reads only the error's
 * `name`, `code` and `$metadata.httpStatusCode`: SES error messages can quote the recipient or sender.
 */
const NAME_CLASSES: ReadonlyArray<[ReadonlySet<string>, TSesErrorClass]> = [
  [throttledNames, "throttled"],
  [authNames, "auth"],
  [rejectedNames, "rejected"],
  [timeoutNames, "timeout"],
];
const CODE_CLASSES: ReadonlyArray<[ReadonlySet<string>, TSesErrorClass]> = [
  [timeoutCodes, "timeout"],
  [networkCodes, "network"],
];

const classifyByStatus = (status: number | undefined): TSesErrorClass => {
  if (status === undefined) return "unknown";
  if (status === 429) return "throttled";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  return status >= 400 ? "rejected" : "unknown";
};

const lookup = (
  value: unknown,
  classes: ReadonlyArray<[ReadonlySet<string>, TSesErrorClass]>
): TSesErrorClass | undefined =>
  typeof value === "string" ? classes.find(([set]) => set.has(value))?.[1] : undefined;

export const classifySesError = (error: unknown): TSesErrorClass => {
  if (!error || typeof error !== "object") return "unknown";
  const { name, code, $metadata } = error as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const status = typeof $metadata?.httpStatusCode === "number" ? $metadata.httpStatusCode : undefined;
  return lookup(name, NAME_CLASSES) ?? lookup(code, CODE_CLASSES) ?? classifyByStatus(status);
};
