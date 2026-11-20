"use client";

import { type ClipboardEvent, forwardRef } from "react";
import { normalizeAccountCode } from "@/modules/auth/lib/email-code/account-code-ui";
import { ACCOUNT_CODE_LENGTH } from "@/modules/auth/lib/email-code/constants";
import { Input } from "@/modules/ui/components/input";
import { Label } from "@/modules/ui/components/label";

interface AccountCodeInputProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (code: string) => void;
  readonly disabled?: boolean;
  /** Id of the text that says where the code was sent, read out with the field. */
  readonly describedBy?: string;
}

/**
 * The field for an emailed account code (delete the account, change its email address): numeric keypad on
 * phones, one-time-code autofill, and spaces or dashes dropped as the user types or pastes. Mirrors the
 * code field of the sign-in form.
 */
export const AccountCodeInput = forwardRef<HTMLInputElement, AccountCodeInputProps>(
  ({ id, label, value, onChange, disabled, describedBy }, ref) => {
    const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
      // `maxLength` would cut "1234 5678" to "1234 567" before onChange sees it, so normalize the paste here.
      event.preventDefault();
      onChange(normalizeAccountCode(event.clipboardData.getData("text")));
    };

    return (
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <Input
          ref={ref}
          id={id}
          name={id}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern={String.raw`\d{${ACCOUNT_CODE_LENGTH}}`}
          maxLength={ACCOUNT_CODE_LENGTH}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={disabled}
          aria-describedby={describedBy}
          value={value}
          onChange={(event) => onChange(normalizeAccountCode(event.target.value))}
          onPaste={onPaste}
          className="tracking-widest"
        />
      </div>
    );
  }
);
AccountCodeInput.displayName = "AccountCodeInput";
