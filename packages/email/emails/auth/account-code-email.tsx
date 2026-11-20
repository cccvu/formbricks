import { Body, Container, Head, Heading, Html, Text } from "react-email";
import { exampleData } from "../../src/lib/example-data";
import { t as mockT } from "../../src/lib/mock-translate";
import { TFunction } from "../../src/types/translations";

/**
 * What an account code is for. `confirm_email_change` goes to the account's CURRENT address and doubles as
 * the notice that someone asked to change it; `verify_new_email` goes to the address being added.
 */
export type TAccountCodePurpose = "delete_account" | "confirm_email_change" | "verify_new_email";

interface AccountCodeEmailProps {
  /** The one-time code, shown exactly as given. */
  readonly code: string;
  readonly validityInMinutes: number;
  readonly purpose: TAccountCodePurpose;
  readonly t?: TFunction;
}

const fontFamily = "'Helvetica Neue', 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * The copy for each purpose. Literal `t("…")` calls on purpose: the translation scanner finds keys by that
 * pattern, so a key built from a lookup table would read as unused.
 */
const getAccountCodeEmailCopy = (purpose: TAccountCodePurpose, t: TFunction) => {
  switch (purpose) {
    case "delete_account":
      return {
        heading: t("emails.account_code_delete_account_heading"),
        text: t("emails.account_code_delete_account_text"),
        didNotRequest: t("emails.account_code_delete_account_did_not_request"),
      };
    case "confirm_email_change":
      return {
        heading: t("emails.account_code_confirm_email_change_heading"),
        text: t("emails.account_code_confirm_email_change_text"),
        didNotRequest: t("emails.account_code_confirm_email_change_did_not_request"),
      };
    case "verify_new_email":
      return {
        heading: t("emails.account_code_verify_new_email_heading"),
        text: t("emails.account_code_verify_new_email_text"),
        didNotRequest: t("emails.account_code_verify_new_email_did_not_request"),
      };
  }
};

/** The subject for each purpose. It never carries the code, so the code stays out of notifications. */
export const getAccountCodeEmailSubject = (purpose: TAccountCodePurpose, t: TFunction): string => {
  switch (purpose) {
    case "delete_account":
      return t("emails.account_code_delete_account_subject");
    case "confirm_email_change":
      return t("emails.account_code_confirm_email_change_subject");
    case "verify_new_email":
      return t("emails.account_code_verify_new_email_subject");
  }
};

/**
 * Delivers a one-time code for an account change (deleting the account, or changing its email address).
 * Bare like the sign-in code email, for the same reasons: no shared chrome, links, images, buttons or
 * remote resources, so a phisher has nothing to imitate and a mail client nothing to fetch, and the
 * subject never carries the code.
 */
export function AccountCodeEmail({
  code,
  validityInMinutes,
  purpose,
  t = mockT,
}: Readonly<AccountCodeEmailProps>): React.JSX.Element {
  const copy = getAccountCodeEmailCopy(purpose, t);
  return (
    <Html>
      <Head>
        {/* Keeps mail clients from turning the digits into a tappable phone number. */}
        <meta name="format-detection" content="telephone=no" />
      </Head>
      <Body style={{ margin: 0, padding: "24px", backgroundColor: "#ffffff", color: "#1e293b", fontFamily }}>
        <Container style={{ maxWidth: "480px" }}>
          <Heading as="h1" style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 16px" }}>
            {copy.heading}
          </Heading>
          <Text style={{ fontSize: "14px", margin: "0 0 16px" }}>{copy.text}</Text>
          <Text
            style={{
              fontFamily: "'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace",
              fontSize: "32px",
              fontWeight: 700,
              letterSpacing: "6px",
              lineHeight: "40px",
              margin: "0 0 16px",
              padding: "12px 16px",
              backgroundColor: "#f1f5f9",
              borderRadius: "6px",
              textAlign: "center",
            }}>
            {code}
          </Text>
          <Text style={{ fontSize: "14px", margin: "0 0 12px" }}>
            {t("emails.account_code_email_expiry", { minutes: String(validityInMinutes) })}
          </Text>
          <Text style={{ fontSize: "14px", margin: 0 }}>{copy.didNotRequest}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default function AccountCodeEmailPreview(): React.JSX.Element {
  return <AccountCodeEmail {...exampleData.accountCodeEmail} />;
}
