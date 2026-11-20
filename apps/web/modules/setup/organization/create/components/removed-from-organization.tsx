"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TUser } from "@formbricks/types/user";
import { DeleteAccountModal } from "@/modules/account/components/DeleteAccountModal";
import type { TAccountDeletionConfirmationMethod } from "@/modules/account/lib/account-deletion-auth";
import { Alert, AlertDescription, AlertTitle } from "@/modules/ui/components/alert";
import { Button } from "@/modules/ui/components/button";

interface RemovedFromOrganizationProps {
  isFormbricksCloud: boolean;
  accountDeletionConfirmationMethod: TAccountDeletionConfirmationMethod;
  user: TUser;
}

export const RemovedFromOrganization = ({
  user,
  isFormbricksCloud,
  accountDeletionConfirmationMethod,
}: Readonly<RemovedFromOrganizationProps>) => {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  return (
    <div className="space-y-4">
      <Alert variant="warning" role="status">
        <AlertTitle>{t("setup.organization.create.no_membership_found")}</AlertTitle>
        <AlertDescription>{t("setup.organization.create.no_membership_found_description")}</AlertDescription>
      </Alert>
      <hr className="my-4 border-slate-200" />
      <p className="text-sm">{t("setup.organization.create.delete_account_description")}</p>
      <DeleteAccountModal
        confirmationMethod={accountDeletionConfirmationMethod}
        open={isModalOpen}
        setOpen={setIsModalOpen}
        user={user}
        isFormbricksCloud={isFormbricksCloud}
        organizationsWithSingleOwner={[]}
      />
      <Button
        onClick={() => {
          setIsModalOpen(true);
        }}>
        {t("setup.organization.create.delete_account")}
      </Button>
    </div>
  );
};
