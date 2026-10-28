/**
 * The bearer token this browser sends, whether the server asks for one, where provider keys live,
 * and saved sign-ins: logins the browser fills by itself, so the model never sees a password.
 */
import type { LoginView } from "@z/core";
import { Form } from "@base-ui/react/form";
import { ArrowUpRight, Check, Globe, KeyRound, LockKeyhole, LockKeyholeOpen, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { token } from "../../api/client.ts";
import { useTokenRequired } from "../../api/data.ts";
import { useDeleteLogin, useLogins, useSaveLogin } from "../../api/logins.ts";
import { useT } from "../../i18n.ts";
import { relativeTime } from "../../lib/format.ts";
import { Confirm } from "../../ui/alert-dialog.tsx";
import { Badge, LoadError, Spinner } from "../../ui/card.tsx";
import { Button } from "../../ui/button.tsx";
import { Dialog } from "../../ui/dialog.tsx";
import { Field, Input } from "../../ui/field.tsx";
import { IconButton } from "../../ui/icon-button.tsx";
import { Row, RowGroup } from "../../ui/row.tsx";
import { notifyError } from "../../ui/toast.tsx";
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
      <SavedSignIns />
    </>
  );
}

// ─── Saved sign-ins ─────────────────────────────────────────────────────────

const host = (origin: string) => origin.replace(/^https:\/\//, "");

export function SavedSignIns() {
  const t = useT();
  const logins = useLogins();
  const [adding, setAdding] = useState(false);

  return (
    <RowGroup>
      <Row label={t.savedSignIns} hint={t.savedSignInsHint}>
        {({ labelId }) => (
          <Dialog.Root open={adding} onOpenChange={setAdding}>
            <Dialog.Trigger render={<Button size="sm" aria-describedby={labelId} />}>
              <Plus aria-hidden />
              {t.addSignIn}
            </Dialog.Trigger>
            <Dialog.Content title={t.addSignIn}>
              <SignInForm onDone={() => setAdding(false)} />
            </Dialog.Content>
          </Dialog.Root>
        )}
      </Row>
      {logins.isPending ? (
        <div className="py-3.5">
          <Spinner />
        </div>
      ) : logins.error && !logins.data ? (
        <div className="py-3.5">
          <LoadError error={logins.error} onRetry={() => void logins.refetch()} retryLabel={t.retry} />
        </div>
      ) : (
        logins.data.map((login) => <SignInRow key={login.id} login={login} />)
      )}
    </RowGroup>
  );
}

function SignInRow({ login }: { login: LoginView }) {
  const t = useT();
  const remove = useDeleteLogin();
  const [editing, setEditing] = useState(false);
  const site = host(login.origin);

  return (
    <Row
      label={
        <span className="flex min-w-0 items-center gap-2">
          <Globe aria-hidden className="size-4 shrink-0 text-fg-muted" />
          <span className="truncate">{site}</span>
          {login.hasTotp && (
            <Badge tone="ok" className="h-5">
              <KeyRound aria-hidden />
              {t.twoStep}
            </Badge>
          )}
        </span>
      }
      hint={
        <>
          <span className="break-all">{login.username}</span>
          {" · "}
          {login.lastUsedAt ? t.lastUsed(relativeTime(login.lastUsedAt)) : t.neverUsed}
        </>
      }
    >
      {() => (
        <>
          <Dialog.Root open={editing} onOpenChange={setEditing}>
            <Dialog.Trigger
              render={
                <IconButton label={t.edit} size="icon-sm">
                  <Pencil aria-hidden />
                </IconButton>
              }
            />
            <Dialog.Content title={t.editSignIn}>
              <SignInForm login={login} onDone={() => setEditing(false)} />
            </Dialog.Content>
          </Dialog.Root>
          <Confirm
            trigger={
              <IconButton label={t.delete} size="icon-sm" className="hover:text-danger">
                <Trash2 aria-hidden />
              </IconButton>
            }
            title={t.deleteSignInConfirm(site)}
            confirmLabel={t.delete}
            onConfirm={() => remove.mutateAsync(login.id).then(() => undefined, notifyError)}
          />
        </>
      )}
    </Row>
  );
}

/** Add, or edit `login`: the password and authenticator secret are never shown, only replaced. */
function SignInForm({ login, onDone }: { login?: LoginView; onDone: () => void }) {
  const t = useT();
  const save = useSaveLogin();
  const [origin, setOrigin] = useState(login?.origin ?? "");
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [dropTotp, setDropTotp] = useState(false);
  const canSave = origin.trim() && username.trim() && (login || password) && !save.isPending;

  return (
    <Form
      aria-label={login ? t.editSignIn : t.addSignIn}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        save.mutate(
          {
            id: login?.id,
            origin: origin.trim(),
            username: username.trim(),
            ...(password ? { password } : {}),
            ...(totp.trim() ? { totpSecret: totp } : dropTotp ? { totpSecret: "" } : {}),
          } as Parameters<typeof save.mutate>[0],
          { onSuccess: onDone, onError: notifyError },
        );
      }}
    >
      <Field label={t.signInSite} description={t.signInSiteHint}>
        <Input
          required
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://example.com"
          value={origin}
          onValueChange={setOrigin}
          className="font-mono text-sm"
        />
      </Field>
      <Field label={t.signInUsername}>
        <Input required autoComplete="off" spellCheck={false} value={username} onValueChange={setUsername} />
      </Field>
      <Field label={t.signInPassword} description={login ? t.signInPasswordKeep : undefined}>
        <Input type="password" required={!login} autoComplete="new-password" value={password} onValueChange={setPassword} />
      </Field>
      <Field label={t.signInTotp} description={login?.hasTotp && !dropTotp ? t.signInTotpKeep : t.signInTotpHint}>
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX XXXX XXXX XXXX"
          value={totp}
          onValueChange={setTotp}
          className="font-mono text-sm"
        />
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {login?.hasTotp && !dropTotp && !totp && (
          <Button size="sm" variant="ghost" className="me-auto text-danger" onClick={() => setDropTotp(true)}>
            {t.removeTotp}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!canSave}>
          {save.isPending ? <Spinner /> : <Check aria-hidden />}
          {t.save}
        </Button>
      </div>
    </Form>
  );
}
