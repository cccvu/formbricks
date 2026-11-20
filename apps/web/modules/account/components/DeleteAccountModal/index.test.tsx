import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TUser } from "@formbricks/types/user";
import enUS from "@/locales/en-US.json";
import {
  ACCOUNT_DELETION_INVALID_CODE_MESSAGE,
  ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE,
} from "@/modules/account/constants";
import { DeleteAccountModal } from "./index";

const { actions, deleteUser, signOut } = vi.hoisted(() => ({
  actions: {
    requestAccountDeletionCodeAction: vi.fn(),
    deleteAccountWithCodeAction: vi.fn(),
    requestSsoAccountDeletionEmailAction: vi.fn(),
  },
  deleteUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("./actions", () => actions);
vi.mock("@/modules/auth/lib/auth-client", () => ({ authClient: { deleteUser } }));
vi.mock("@/modules/auth/hooks/use-sign-out", () => ({ useSignOut: () => ({ signOut }) }));
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));

// Resolve keys against the real en-US copy, so the assertions below check what users actually read.
const translate = (key: string, values?: Record<string, string | number>) => {
  const message = key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enUS);
  if (typeof message !== "string") throw new Error(`Missing en-US translation: ${key}`);
  return message.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
};
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

const profile = enUS.workspace.settings.profile;
const emailCode = enUS.auth.login.email_code;
const EMAIL = "ada@example.com";
const user = { id: "user-1", email: EMAIL } as TUser;
const RATE_LIMITED = "Maximum number of requests reached. Please try again later.";

const flush = () => act(async () => {});

const renderModal = (confirmationMethod: "password" | "email_link" | "email_code") =>
  render(
    <DeleteAccountModal
      confirmationMethod={confirmationMethod}
      open
      setOpen={vi.fn()}
      user={user}
      isFormbricksCloud={false}
      organizationsWithSingleOwner={[]}
    />
  );

const confirmEmail = () =>
  fireEvent.change(screen.getByTestId("deleteAccountConfirmation"), { target: { value: EMAIL } });

const sendCode = async () => {
  confirmEmail();
  fireEvent.click(screen.getByRole("button", { name: emailCode.send_code }));
  await flush();
};

const deleteButton = () => screen.getByRole("button", { name: enUS.common.delete });

let originalLocation: Location;
const locationReplace = vi.fn();

describe("DeleteAccountModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { replace: locationReplace },
    });
    actions.requestAccountDeletionCodeAction.mockResolvedValue({ data: { sent: true } });
    actions.deleteAccountWithCodeAction.mockResolvedValue({ data: { deleted: true } });
    signOut.mockResolvedValue({ url: "/auth/login" });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  describe("email code", () => {
    test("sends a code only once the email is confirmed, then asks for it", async () => {
      renderModal("email_code");
      expect(screen.getByRole("button", { name: emailCode.send_code })).toBeDisabled();
      expect(screen.queryByLabelText(enUS.common.password)).not.toBeInTheDocument();

      await sendCode();

      expect(actions.requestAccountDeletionCodeAction).toHaveBeenCalledTimes(1);
      const codeInput = screen.getByLabelText(profile.delete_account_code_label);
      expect(codeInput).toHaveFocus();
      expect(codeInput).toHaveAttribute("inputmode", "numeric");
      expect(codeInput).toHaveAttribute("autocomplete", "one-time-code");
      expect(screen.getByRole("status")).toHaveTextContent(
        profile.delete_account_code_sent.replace("{email}", EMAIL).replace("{minutes}", "10")
      );
      expect(
        screen.getByRole("button", { name: emailCode.resend_code_in.replace("{seconds}", "60") })
      ).toBeDisabled();
    });

    test("deletes with the code, then signs out and leaves", async () => {
      renderModal("email_code");
      await sendCode();
      expect(deleteButton()).toBeDisabled();

      fireEvent.change(screen.getByLabelText(profile.delete_account_code_label), {
        target: { value: "1234 5678" },
      });
      expect(screen.getByLabelText(profile.delete_account_code_label)).toHaveValue("12345678");
      fireEvent.click(deleteButton());
      await flush();

      expect(actions.deleteAccountWithCodeAction).toHaveBeenCalledWith({ code: "12345678" });
      expect(signOut).toHaveBeenCalledWith(expect.objectContaining({ reason: "account_deletion" }));
      expect(locationReplace).toHaveBeenCalledWith("/auth/login");
      expect(deleteUser).not.toHaveBeenCalled();
    });

    test("still leaves when sign-out fails because the session is already gone", async () => {
      signOut.mockRejectedValue(new Error("no session"));
      renderModal("email_code");
      await sendCode();
      fireEvent.change(screen.getByLabelText(profile.delete_account_code_label), {
        target: { value: "12345678" },
      });
      fireEvent.click(deleteButton());
      await flush();

      expect(locationReplace).toHaveBeenCalledWith("/auth/login");
    });

    test.each([
      ["an invalid code", ACCOUNT_DELETION_INVALID_CODE_MESSAGE, profile.account_code_invalid],
      ["a sole owner", ACCOUNT_DELETION_SOLE_OWNER_BLOCK_MESSAGE, profile.warning_cannot_delete_account],
      ["a rate limit", RATE_LIMITED, profile.account_code_too_many_attempts],
      [
        "anything else",
        "Something went wrong while executing the operation.",
        enUS.common.something_went_wrong_please_try_again,
      ],
    ])("explains %s and stays open", async (_, serverError, expected) => {
      actions.deleteAccountWithCodeAction.mockResolvedValue({ serverError });
      renderModal("email_code");
      await sendCode();
      fireEvent.change(screen.getByLabelText(profile.delete_account_code_label), {
        target: { value: "12345678" },
      });
      fireEvent.click(deleteButton());
      await flush();

      expect(screen.getByRole("alert")).toHaveTextContent(expected);
      expect(screen.getByLabelText(profile.delete_account_code_label)).toHaveFocus();
      expect(signOut).not.toHaveBeenCalled();
      expect(locationReplace).not.toHaveBeenCalled();
    });

    test("explains a rate-limited send and does not ask for a code", async () => {
      actions.requestAccountDeletionCodeAction.mockResolvedValue({ serverError: RATE_LIMITED });
      renderModal("email_code");

      await sendCode();

      expect(screen.getByRole("alert")).toHaveTextContent(profile.account_code_too_many_attempts);
      expect(screen.queryByLabelText(profile.delete_account_code_label)).not.toBeInTheDocument();
    });

    test("resends after the cooldown", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        renderModal("email_code");
        await sendCode();

        for (let second = 0; second < 60; second++) {
          await act(async () => {
            vi.advanceTimersByTime(1000);
          });
        }
        fireEvent.click(screen.getByRole("button", { name: emailCode.resend_code }));
        await flush();

        expect(actions.requestAccountDeletionCodeAction).toHaveBeenCalledTimes(2);
        expect(screen.getByRole("status")).toHaveTextContent(profile.account_code_resent);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test("password mode is unchanged: the password confirms, no code is sent", async () => {
    deleteUser.mockResolvedValue({ error: null });
    renderModal("password");
    expect(screen.queryByRole("button", { name: emailCode.send_code })).not.toBeInTheDocument();

    confirmEmail();
    fireEvent.change(screen.getByTestId("deleteAccountPassword"), { target: { value: "secret-password" } });
    fireEvent.click(deleteButton());
    await flush();

    expect(deleteUser).toHaveBeenCalledWith({ password: "secret-password" });
    expect(actions.requestAccountDeletionCodeAction).not.toHaveBeenCalled();
    expect(actions.deleteAccountWithCodeAction).not.toHaveBeenCalled();
    expect(locationReplace).toHaveBeenCalledWith("/auth/login");
  });

  test("email link mode is unchanged: it mails the link", async () => {
    actions.requestSsoAccountDeletionEmailAction.mockResolvedValue({ data: { emailSent: true } });
    renderModal("email_link");

    confirmEmail();
    fireEvent.click(deleteButton());
    await flush();

    expect(actions.requestSsoAccountDeletionEmailAction).toHaveBeenCalledTimes(1);
    expect(actions.requestAccountDeletionCodeAction).not.toHaveBeenCalled();
    expect(
      screen.getByText(profile.account_deletion_email_sent.replace("{email}", EMAIL))
    ).toBeInTheDocument();
  });
});
