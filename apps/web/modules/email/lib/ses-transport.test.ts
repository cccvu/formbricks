import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type TSesClient,
  classifySesError,
  getSesClient,
  getSesClientConfig,
  resetSesClientForTests,
  sendEmailWithSes,
} from "./ses-transport";

const mocks = vi.hoisted(() => ({
  constants: {
    SES_REGION: "us-east-1" as string | undefined,
    SES_CONFIGURATION_SET: undefined as string | undefined,
    SES_EMAIL_ENVIRONMENT: undefined as string | undefined,
  },
}));

vi.mock("@/lib/constants", () => mocks.constants);

const message = {
  to: "recipient@example.com",
  from: "Formbricks <noreply@example.com>",
  subject: "Invitation",
  html: "<p>Join</p>",
};

const fakeClient = (send: TSesClient["send"]): TSesClient => ({ send });

const sentInput = (send: ReturnType<typeof vi.fn>) => {
  expect(send).toHaveBeenCalledTimes(1);
  const command = send.mock.calls[0][0];
  expect(command).toBeInstanceOf(SendEmailCommand);
  return (command as SendEmailCommand).input;
};

describe("sendEmailWithSes", () => {
  beforeEach(() => {
    mocks.constants.SES_CONFIGURATION_SET = undefined;
    mocks.constants.SES_EMAIL_ENVIRONMENT = undefined;
  });

  test("sends the raw MIME message without a configuration set or tags by default", async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: "ses-message-id" });

    const result = await sendEmailWithSes(message, "invite", fakeClient(send));

    const input = sentInput(send);
    expect(input.FromEmailAddress).toBe("Formbricks <noreply@example.com>");
    expect(input.Destination).toEqual({ ToAddresses: ["recipient@example.com"] });
    expect(input.Content?.Raw?.Data?.toString()).toContain("Subject: Invitation");
    expect(input).not.toHaveProperty("ConfigurationSetName");
    expect(input).not.toHaveProperty("EmailTags");
    // Only the MessageId comes back: no envelope (recipient) and no raw message body.
    expect(result).toEqual({ serverMessageId: "ses-message-id" });
  });

  test("sends the configuration set and the same tags as the SMTP headers when configured", async () => {
    mocks.constants.SES_CONFIGURATION_SET = "formbricks-email-config";
    mocks.constants.SES_EMAIL_ENVIRONMENT = "staging";
    const send = vi.fn().mockResolvedValue({ MessageId: "ses-message-id" });

    await sendEmailWithSes(message, "password_reset", fakeClient(send));

    const input = sentInput(send);
    expect(input.ConfigurationSetName).toBe("formbricks-email-config");
    expect(input.EmailTags).toEqual([
      { Name: "email_type", Value: "password_reset" },
      { Name: "environment", Value: "staging" },
    ]);
    // Tags travel as API parameters, not as headers in the message.
    expect(input.Content?.Raw?.Data?.toString()).not.toMatch(/X-SES-/i);
  });

  test("propagates a client failure unchanged", async () => {
    const failure = Object.assign(new Error("Rate exceeded for recipient@example.com"), {
      name: "TooManyRequestsException",
      $metadata: { httpStatusCode: 429 },
    });
    const send = vi.fn().mockRejectedValue(failure);

    await expect(sendEmailWithSes(message, "invite", fakeClient(send))).rejects.toBe(failure);
    expect(classifySesError(failure)).toBe("throttled");
  });
});

describe("classifySesError", () => {
  test.each([
    [{ name: "TooManyRequestsException" }, "throttled"],
    [{ name: "LimitExceededException", $metadata: { httpStatusCode: 400 } }, "throttled"],
    [{ name: "MessageRejected", $metadata: { httpStatusCode: 400 } }, "rejected"],
    [{ name: "MailFromDomainNotVerifiedException" }, "rejected"],
    [{ name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } }, "auth"],
    [{ name: "CredentialsProviderError" }, "auth"],
    [{ name: "TimeoutError" }, "timeout"],
    [{ name: "Error", code: "ETIMEDOUT" }, "timeout"],
    [{ name: "Error", code: "ECONNREFUSED" }, "network"],
    [{ name: "InternalFailure", $metadata: { httpStatusCode: 500 } }, "server"],
    [{ name: "SomethingNew", $metadata: { httpStatusCode: 429 } }, "throttled"],
    [{ name: "SomethingNew", $metadata: { httpStatusCode: 404 } }, "rejected"],
    [{ name: "SomethingNew", code: "ESES" }, "unknown"],
    [null, "unknown"],
    ["MessageRejected", "unknown"],
  ])("classifies %j as %s", (error, expected) => {
    expect(classifySesError(error)).toBe(expected);
  });

  test("never uses the error message, even when it names a known error class", () => {
    const error = new Error("ThrottlingException for recipient@example.com");
    const result = classifySesError(error);
    expect(result).toBe("unknown");
    expect(result).not.toContain("recipient@example.com");
  });
});

describe("getSesClient", () => {
  afterEach(() => {
    resetSesClientForTests();
  });

  test("retries once with short connection and request timeouts, and no endpoint or static keys", () => {
    const config = getSesClientConfig();
    expect(config).toEqual({
      region: "us-east-1",
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 1000, requestTimeout: 3000, throwOnRequestTimeout: true },
    });
    expect(config).not.toHaveProperty("endpoint");
    expect(config).not.toHaveProperty("credentials");
  });

  test("builds one SDK client from that configuration and reuses it", async () => {
    const client = getSesClient();
    expect(getSesClient()).toBe(client);
    await expect(client.config.maxAttempts()).resolves.toBe(2);
    await expect(client.config.region()).resolves.toBe("us-east-1");

    resetSesClientForTests();
    expect(getSesClient()).not.toBe(client);
  });
});
