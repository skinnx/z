/** The bearer token this browser sends, whether the server asks for one, and where provider keys live. */
import { ArrowUpRight, KeyRound, LockKeyhole, LockKeyholeOpen, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { token } from "../../api/client.ts";
import { useTokenRequired } from "../../api/data.ts";
import { useT } from "../../i18n.ts";
import { Badge } from "../../ui/card.tsx";
import { Button } from "../../ui/button.tsx";
import { Dialog } from "../../ui/dialog.tsx";
import { Row, RowGroup } from "../../ui/row.tsx";
import { TokenForm } from "../../shell/token-dialog.tsx";
import { useSettingsRoute } from "../route.ts";

export function SecurityPanel() {
  const t = useT();
  const route = useSettingsRoute();
  const required = useTokenRequired();
  const stored = token.use();
  const [setting, setSetting] = useState(false);

  return (
    <>
      <RowGroup>
        <Row
          label={t.tokenRequired}
          hint={required.data === undefined ? (required.error ? required.error.message : t.loading) : required.data ? t.tokenRequiredYes : t.tokenRequiredNo}
        >
          {() =>
            required.data === undefined ? null : required.data ? (
              <Badge tone="ok">
                <LockKeyhole aria-hidden />
                {t.yes}
              </Badge>
            ) : (
              <Badge tone="warn">
                <LockKeyholeOpen aria-hidden />
                {t.no}
              </Badge>
            )
          }
        </Row>
        <Row label={t.apiTokenHere} hint={stored ? t.tokenStored : required.data ? t.tokenMissing : t.tokenOptional}>
          {({ labelId }) => (
            <>
              <Dialog.Root open={setting} onOpenChange={setSetting}>
                <Dialog.Trigger render={<Button size="sm" aria-describedby={labelId} />}>
                  <KeyRound aria-hidden />
                  {stored ? t.changeToken : t.setToken}
                </Dialog.Trigger>
                <Dialog.Content title={t.apiTokenHere}>
                  <TokenForm submitLabel={t.save} onDone={() => setSetting(false)} />
                </Dialog.Content>
              </Dialog.Root>
              {stored && (
                <Button size="sm" variant="danger" aria-describedby={labelId} onClick={() => token.set(null)}>
                  {t.clearToken}
                </Button>
              )}
            </>
          )}
        </Row>
      </RowGroup>
      <RowGroup>
        <Row
          label={
            <span className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="size-4 text-ok" />
              {t.providerKeys}
            </span>
          }
          hint={t.providerKeysSafe}
        >
          {({ labelId }) => (
            <Button size="sm" aria-describedby={labelId} onClick={() => route.leave("/models")}>
              {t.nav_models}
              <ArrowUpRight aria-hidden className="rtl:-scale-x-100" />
            </Button>
          )}
        </Row>
      </RowGroup>
    </>
  );
}
