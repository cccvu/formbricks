import { Body, Container, Head, Heading, Html, Text } from "react-email";
import { exampleData } from "../../src/lib/example-data";
import { t as mockT } from "../../src/lib/mock-translate";
import { TFunction } from "../../src/types/translations";

interface SignInCodeEmailProps {
  /** The one-time code, shown exactly as given. */
  readonly code: string;
  readonly validityInMinutes: number;
  readonly t?: TFunction;
}

const fontFamily = "'Helvetica Neue', 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * Delivers a one-time sign-in code. Deliberately bare — no shared chrome, links, images, buttons or
 * remote resources: the code is the only thing the reader needs, and a mail without links gives a phisher
 * nothing to imitate and a mail client nothing to fetch. The subject never carries the code, so it does
 * not show up in notifications or inbox previews.
 */
export function SignInCodeEmail({
  code,
  validityInMinutes,
  t = mockT,
}: Readonly<SignInCodeEmailProps>): React.JSX.Element {
  return (
    <Html>
      <Head>
        {/* Keeps mail clients from turning the digits into a tappable phone number. */}
        <meta name="format-detection" content="telephone=no" />
      </Head>
      <Body style={{ margin: 0, padding: "24px", backgroundColor: "#ffffff", color: "#1e293b", fontFamily }}>
        <Container style={{ maxWidth: "480px" }}>
          <Heading as="h1" style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 16px" }}>
            {t("emails.sign_in_code_email_heading")}
          </Heading>
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
            {t("emails.sign_in_code_email_expiry", { minutes: String(validityInMinutes) })}
          </Text>
          <Text style={{ fontSize: "14px", margin: 0 }}>
            {t("emails.sign_in_code_email_did_not_request")}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default function SignInCodeEmailPreview(): React.JSX.Element {
  return <SignInCodeEmail {...exampleData.signInCodeEmail} />;
}
