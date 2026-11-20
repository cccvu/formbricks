import { act, fireEvent, render, screen } from "@testing-library/react";
import toast from "react-hot-toast";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TUser } from "@formbricks/types/user";
import enUS from "@/locales/en-US.json";
import { EditProfileDetailsForm } from "./EditProfileDetailsForm";

const { updateUserAction } = vi.hoisted(() => ({ updateUserAction: vi.fn() }));

vi.mock("../actions", () => ({ updateUserAction, resetPasswordAction: vi.fn() }));
vi.mock("@/modules/auth/hooks/use-sign-out", () => ({ useSignOut: () => ({ signOut: vi.fn() }) }));
vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock("./password-confirmation-modal", () => ({
  PasswordConfirmationModal: ({ open, newEmail }: Readonly<{ open: boolean; newEmail: string }>) =>
    open ? <div data-testid="password-modal">{newEmail}</div> : null,
}));
vi.mock("./email-change-code-modal", () => ({
  EmailChangeCodeModal: ({ open, newEmail }: Readonly<{ open: boolean; newEmail: string }>) =>
    open ? <div data-testid="email-code-modal">{newEmail}</div> : null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const message = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], enUS);
      if (typeof message !== "string") throw new Error(`Missing en-US translation: ${key}`);
      return message;
    },
  }),
}));

const user = {
  id: "user-1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  locale: "en-US",
  identityProvider: "email",
} as TUser;
const NEW_EMAIL = "ada@new.example.com";

const reload = vi.fn();
let originalLocation: Location;
const flush = () => act(async () => {});

const renderForm = (emailCodeAuthEnabled?: boolean) =>
  render(
    <EditProfileDetailsForm
      user={user}
      emailVerificationDisabled={false}
      emailCodeAuthEnabled={emailCodeAuthEnabled}
    />
  );

const change = async (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await flush();
};

const submit = async () => {
  fireEvent.click(screen.getByRole("button", { name: enUS.common.update }));
  await flush();
};

describe("EditProfileDetailsForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { reload } });
    updateUserAction.mockResolvedValue({ data: { id: user.id } });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  test("without email codes, a new address still asks for the password", async () => {
    renderForm();

    await change(enUS.common.email, NEW_EMAIL);
    await submit();

    expect(screen.getByTestId("password-modal")).toHaveTextContent(NEW_EMAIL);
    expect(screen.queryByTestId("email-code-modal")).not.toBeInTheDocument();
    expect(updateUserAction).not.toHaveBeenCalled();
  });

  describe("with email codes", () => {
    test("a new address opens the code modal and is never sent to updateUserAction", async () => {
      renderForm(true);

      await change(enUS.common.email, NEW_EMAIL);
      await submit();

      expect(screen.getByTestId("email-code-modal")).toHaveTextContent(NEW_EMAIL);
      expect(screen.queryByTestId("password-modal")).not.toBeInTheDocument();
      expect(updateUserAction).not.toHaveBeenCalled();
    });

    test("a name change saves without the email field", async () => {
      renderForm(true);

      await change(enUS.common.full_name, "Ada King");
      await submit();

      expect(updateUserAction).toHaveBeenCalledWith({ name: "Ada King" });
      expect(toast.success).toHaveBeenCalledWith(
        enUS.workspace.settings.profile.profile_updated_successfully
      );
      expect(reload).toHaveBeenCalled();
      expect(screen.queryByTestId("email-code-modal")).not.toBeInTheDocument();
    });

    test("a name and address change saves the name, then opens the code modal", async () => {
      renderForm(true);

      await change(enUS.common.full_name, "Ada King");
      await change(enUS.common.email, NEW_EMAIL);
      await submit();

      expect(updateUserAction).toHaveBeenCalledWith({ name: "Ada King" });
      expect(screen.getByTestId("email-code-modal")).toHaveTextContent(NEW_EMAIL);
      expect(reload).not.toHaveBeenCalled();
    });

    test("a failed name save does not open the code modal", async () => {
      updateUserAction.mockResolvedValue({ serverError: "Something went wrong" });
      renderForm(true);

      await change(enUS.common.full_name, "Ada King");
      await change(enUS.common.email, NEW_EMAIL);
      await submit();

      expect(toast.error).toHaveBeenCalledWith("Something went wrong");
      expect(screen.queryByTestId("email-code-modal")).not.toBeInTheDocument();
    });
  });
});
