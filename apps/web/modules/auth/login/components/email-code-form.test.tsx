import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import enUS from "@/locales/en-US.json";
import { EMAIL_CODE_RESEND_COOLDOWN_SECONDS, EmailCodeForm } from "./email-code-form";

const { sendVerificationOtp, signInEmailOtp, routerPush } = vi.hoisted(() => ({
  sendVerificationOtp: vi.fn(),
  signInEmailOtp: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("@/modules/auth/lib/auth-client", () => ({
  authClient: {
    emailOtp: { sendVerificationOtp },
    signIn: { emailOtp: signInEmailOtp },
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

// Resolve keys against the real en-US copy, so the assertions below check what users actually read.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const message = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enUS);
      if (typeof message !== "string") throw new Error(`Missing en-US translation: ${key}`);
      return message.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
    },
  }),
}));

const localStorageMock = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
const copy = enUS.auth.login.email_code;
const EMAIL = "ada@example.com";
const CODE = "12345678";

const flush = () => act(async () => {});

// The countdown re-arms a one-second timer after each render, so advance one second at a time.
const advanceSeconds = async (seconds: number) => {
  for (let second = 0; second < seconds; second++) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
};

const submitEmail = async (email = EMAIL) => {
  fireEvent.change(screen.getByLabelText(enUS.common.email), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: copy.send_code }));
  await flush();
};

const submitCode = async (code = CODE) => {
  fireEvent.change(screen.getByLabelText(copy.code_label), { target: { value: code } });
  fireEvent.click(screen.getByRole("button", { name: copy.sign_in }));
  await flush();
};

const renderForm = () => render(<EmailCodeForm resolvedCallbackPath="/invite?token=tok" />);

describe("EmailCodeForm", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock);
    vi.clearAllMocks();
    sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
    signInEmailOtp.mockResolvedValue({ data: { token: "t" }, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("requests a sign-in code for the normalized email and moves to the code step", async () => {
    renderForm();

    await submitEmail("  Ada@Example.com ");

    expect(sendVerificationOtp).toHaveBeenCalledWith({ email: EMAIL, type: "sign-in" });
    const codeInput = screen.getByLabelText(copy.code_label);
    expect(codeInput).toHaveFocus();
    expect(codeInput).toHaveAttribute("inputmode", "numeric");
    expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
    expect(codeInput).toHaveAttribute("maxlength", "8");
    expect(screen.getByRole("status")).toHaveTextContent(
      copy.code_sent_description.replace("{email}", EMAIL)
    );
  });

  test("prefills the email when the login page passes one", () => {
    render(<EmailCodeForm prefilledEmail={EMAIL} resolvedCallbackPath="/" />);

    expect(screen.getByLabelText(enUS.common.email)).toHaveValue(EMAIL);
  });

  test("signs in with the code and navigates to the callback path", async () => {
    renderForm();
    await submitEmail();

    await submitCode();

    expect(signInEmailOtp).toHaveBeenCalledWith({ email: EMAIL, otp: CODE });
    expect(routerPush).toHaveBeenCalledWith("/invite?token=tok");
  });

  test("strips spaces and dashes from the typed code", async () => {
    renderForm();
    await submitEmail();

    fireEvent.change(screen.getByLabelText(copy.code_label), { target: { value: "1234 56-78" } });

    expect(screen.getByLabelText(copy.code_label)).toHaveValue(CODE);
  });

  test.each([
    ["an invalid code", { status: 400, code: "INVALID_OTP", message: "Invalid OTP" }],
    ["an expired code", { status: 400, code: "OTP_EXPIRED", message: "OTP expired" }],
    ["a refused account", { status: 403, code: "FORBIDDEN", message: "User not found" }],
  ])("shows the same generic error for %s", async (_, error) => {
    signInEmailOtp.mockResolvedValue({ data: null, error });
    renderForm();
    await submitEmail();

    await submitCode();

    expect(screen.getByRole("alert")).toHaveTextContent(copy.invalid_code);
    expect(screen.queryByText(error.message)).not.toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  test("shows the generic error when the request itself fails", async () => {
    signInEmailOtp.mockRejectedValue(new Error("network down"));
    renderForm();
    await submitEmail();

    await submitCode();

    expect(screen.getByRole("alert")).toHaveTextContent(copy.invalid_code);
  });

  test("shows the rate-limit message on 429, for sign-in and for sending", async () => {
    signInEmailOtp.mockResolvedValue({ data: null, error: { status: 429, message: "Too many requests" } });
    renderForm();
    await submitEmail();
    await submitCode();

    expect(screen.getByRole("alert")).toHaveTextContent(copy.too_many_attempts);

    fireEvent.click(screen.getByRole("button", { name: copy.use_a_different_email }));
    sendVerificationOtp.mockResolvedValue({ data: null, error: { status: 429, message: "Too many" } });
    await submitEmail();

    expect(screen.getByRole("alert")).toHaveTextContent(copy.too_many_attempts);
    expect(screen.queryByLabelText(copy.code_label)).not.toBeInTheDocument();
  });

  test("disables resend for the cooldown, then resends a sign-in code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderForm();
    await submitEmail();

    const counting = screen.getByRole("button", {
      name: copy.resend_code_in.replace("{seconds}", String(EMAIL_CODE_RESEND_COOLDOWN_SECONDS)),
    });
    expect(counting).toBeDisabled();

    await advanceSeconds(10);
    expect(
      screen.getByRole("button", {
        name: copy.resend_code_in.replace("{seconds}", String(EMAIL_CODE_RESEND_COOLDOWN_SECONDS - 10)),
      })
    ).toBeDisabled();

    await advanceSeconds(EMAIL_CODE_RESEND_COOLDOWN_SECONDS - 10);
    const resend = screen.getByRole("button", { name: copy.resend_code });
    expect(resend).toBeEnabled();

    fireEvent.click(resend);
    await flush();

    expect(sendVerificationOtp).toHaveBeenCalledTimes(2);
    expect(sendVerificationOtp).toHaveBeenLastCalledWith({ email: EMAIL, type: "sign-in" });
    expect(screen.getByRole("status")).toHaveTextContent(copy.code_resent);
    expect(
      screen.getByRole("button", {
        name: copy.resend_code_in.replace("{seconds}", String(EMAIL_CODE_RESEND_COOLDOWN_SECONDS)),
      })
    ).toBeDisabled();
  });

  test("goes back to the email step", async () => {
    renderForm();
    await submitEmail();

    fireEvent.click(screen.getByRole("button", { name: copy.use_a_different_email }));

    expect(screen.getByLabelText(enUS.common.email)).toHaveValue(EMAIL);
    expect(screen.queryByLabelText(copy.code_label)).not.toBeInTheDocument();
  });

  test("never says whether an account exists", async () => {
    signInEmailOtp.mockResolvedValue({ data: null, error: { status: 400, code: "INVALID_OTP" } });
    const { container } = renderForm();
    await submitEmail();
    await submitCode();

    const accountExistence = /account|not found|no user|exists|registered|unknown/i;
    expect(container.textContent).not.toMatch(accountExistence);
    // The invite hint says "account" by design, but it is static copy chosen from the callback URL alone,
    // before any request, and reads the same for every address; it is covered by the tests below.
    const { invite_hint: _inviteHint, ...answers } = copy;
    for (const message of Object.values(answers)) {
      expect(message).not.toMatch(accountExistence);
    }
  });

  test("tells an invitee which address to use, on the email step only", async () => {
    render(<EmailCodeForm resolvedCallbackPath="/invite?token=tok" isInvite />);

    expect(screen.getByText(copy.invite_hint)).toBeInTheDocument();

    await submitEmail();

    expect(screen.queryByText(copy.invite_hint)).not.toBeInTheDocument();
  });

  test("shows no invite hint without an invitation", () => {
    renderForm();

    expect(screen.queryByText(copy.invite_hint)).not.toBeInTheDocument();
  });
});
