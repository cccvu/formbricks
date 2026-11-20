import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import enUS from "@/locales/en-US.json";
import {
  EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE,
  EMAIL_CHANGE_INVALID_CODE_MESSAGE,
} from "../lib/email-change-messages";
import { EmailChangeCodeModal } from "./email-change-code-modal";

const { actions } = vi.hoisted(() => ({
  actions: {
    sendEmailChangeCurrentCodeAction: vi.fn(),
    requestEmailChangeAction: vi.fn(),
    confirmEmailChangeAction: vi.fn(),
  },
}));

vi.mock("../actions", () => actions);

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

const profile = enUS.workspace.settings.profile;
const emailCode = enUS.auth.login.email_code;
const CURRENT = "ada@example.com";
const NEW = "ada@new.example.com";
const RATE_LIMITED = "Maximum number of requests reached. Please try again later.";
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));

const flush = () => act(async () => {});
const setOpen = vi.fn();
const reload = vi.fn();
let originalLocation: Location;

const renderModal = () =>
  render(<EmailChangeCodeModal open setOpen={setOpen} currentEmail={CURRENT} newEmail={NEW} />);

const click = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await flush();
};

const enterCode = async (label: string, code: string, submit: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value: code } });
  await click(submit);
};

const reachNewCodeStep = async () => {
  renderModal();
  await click(emailCode.send_code);
  await enterCode(profile.email_change_current_code_label, "11112222", enUS.common.continue);
};

describe("EmailChangeCodeModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { reload } });
    actions.sendEmailChangeCurrentCodeAction.mockResolvedValue({ data: { sent: true } });
    actions.requestEmailChangeAction.mockResolvedValue({ data: { sent: true } });
    actions.confirmEmailChangeAction.mockResolvedValue({
      data: { changed: true, otherSessionsRevoked: true },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  test("walks through the three steps and changes the address", async () => {
    renderModal();
    expect(
      screen.getByText(fill(profile.email_change_intro, { currentEmail: CURRENT, newEmail: NEW }))
    ).toBeInTheDocument();

    await click(emailCode.send_code);

    expect(actions.sendEmailChangeCurrentCodeAction).toHaveBeenCalledTimes(1);
    const currentCode = screen.getByLabelText(profile.email_change_current_code_label);
    expect(currentCode).toHaveFocus();
    expect(currentCode).toHaveAttribute("autocomplete", "one-time-code");
    expect(
      screen.getByText(fill(profile.email_change_current_code_sent, { email: CURRENT, minutes: 10 }))
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: enUS.common.continue })).toBeDisabled();

    await enterCode(profile.email_change_current_code_label, "1111-2222", enUS.common.continue);

    expect(actions.requestEmailChangeAction).toHaveBeenCalledWith({ newEmail: NEW, code: "11112222" });
    const newCode = screen.getByLabelText(profile.email_change_new_code_label);
    expect(newCode).toHaveFocus();
    expect(newCode).toHaveValue("");
    expect(
      screen.getByText(fill(profile.email_change_new_code_sent, { email: NEW, minutes: 10 }))
    ).toBeInTheDocument();

    await enterCode(profile.email_change_new_code_label, "33334444", profile.email_change_confirm);

    expect(actions.confirmEmailChangeAction).toHaveBeenCalledWith({ newEmail: NEW, code: "33334444" });
    expect(screen.getByRole("status")).toHaveTextContent(fill(profile.email_change_success, { email: NEW }));
    const done = screen.getByRole("button", { name: enUS.common.done });
    expect(done).toHaveFocus();

    fireEvent.click(done);
    expect(reload).toHaveBeenCalled();
  });

  test("warns when other devices could not be signed out", async () => {
    actions.confirmEmailChangeAction.mockResolvedValue({
      data: { changed: true, otherSessionsRevoked: false },
    });
    await reachNewCodeStep();

    await enterCode(profile.email_change_new_code_label, "33334444", profile.email_change_confirm);

    expect(screen.getByRole("status")).toHaveTextContent(
      fill(profile.email_change_success_sessions_not_revoked, { email: NEW })
    );
  });

  test("keeps the user on step 2 when the current-address code is wrong", async () => {
    actions.requestEmailChangeAction.mockResolvedValue({ serverError: EMAIL_CHANGE_INVALID_CODE_MESSAGE });
    renderModal();
    await click(emailCode.send_code);

    await enterCode(profile.email_change_current_code_label, "11112222", enUS.common.continue);

    expect(screen.getByRole("alert")).toHaveTextContent(profile.account_code_invalid);
    expect(screen.getByLabelText(profile.email_change_current_code_label)).toHaveFocus();
    expect(screen.queryByLabelText(profile.email_change_new_code_label)).not.toBeInTheDocument();
  });

  test("says when the new address belongs to another account", async () => {
    actions.confirmEmailChangeAction.mockResolvedValue({ serverError: EMAIL_CHANGE_EMAIL_IN_USE_MESSAGE });
    await reachNewCodeStep();

    await enterCode(profile.email_change_new_code_label, "33334444", profile.email_change_confirm);

    expect(screen.getByRole("alert")).toHaveTextContent(profile.email_change_email_in_use);
    expect(reload).not.toHaveBeenCalled();
  });

  test("explains a rate limit when sending the first code", async () => {
    actions.sendEmailChangeCurrentCodeAction.mockResolvedValue({ serverError: RATE_LIMITED });
    renderModal();

    await click(emailCode.send_code);

    expect(screen.getByRole("alert")).toHaveTextContent(profile.account_code_too_many_attempts);
    expect(screen.queryByLabelText(profile.email_change_current_code_label)).not.toBeInTheDocument();
  });

  test("reloads the profile when a retry finds the code spent by a request that lost its answer", async () => {
    actions.confirmEmailChangeAction.mockRejectedValueOnce(new Error("network down"));
    actions.confirmEmailChangeAction.mockResolvedValueOnce({
      serverError: EMAIL_CHANGE_INVALID_CODE_MESSAGE,
    });
    await reachNewCodeStep();

    await enterCode(profile.email_change_new_code_label, "33334444", profile.email_change_confirm);
    expect(screen.getByRole("alert")).toHaveTextContent(profile.email_change_outcome_unknown);
    expect(reload).not.toHaveBeenCalled();

    await click(profile.email_change_confirm);

    expect(reload).toHaveBeenCalled();
  });

  test("a wrong new-address code without an earlier lost answer is just an error", async () => {
    actions.confirmEmailChangeAction.mockResolvedValue({ serverError: EMAIL_CHANGE_INVALID_CODE_MESSAGE });
    await reachNewCodeStep();

    await enterCode(profile.email_change_new_code_label, "33334444", profile.email_change_confirm);

    expect(screen.getByRole("alert")).toHaveTextContent(profile.account_code_invalid);
    expect(reload).not.toHaveBeenCalled();
  });

  test("starts over from step 3", async () => {
    await reachNewCodeStep();

    await click(profile.email_change_start_over);

    expect(screen.getByRole("button", { name: emailCode.send_code })).toBeInTheDocument();
    expect(screen.queryByLabelText(profile.email_change_new_code_label)).not.toBeInTheDocument();
  });

  test("cancel closes without reloading", async () => {
    renderModal();

    await click(enUS.common.cancel);

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
