/** Take everything with you, or wipe chats and memories. */
import { ClipboardCopy, Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { useExportData } from "../../api/data.ts";
import { useCopyDiagnostics, useDownloadDiagnostics } from "../../api/setup.ts";
import { useDeleteAllThreads, useThreads } from "../../api/threads.ts";
import { useT } from "../../i18n.ts";
import { Confirm } from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Spinner } from "../../ui/card.tsx";
import { Row, RowGroup } from "../../ui/row.tsx";
import { notify, notifyError } from "../../ui/toast.tsx";
import { DeleteAllMemoriesRow } from "./personalization.tsx";

export function DataPanel() {
  return (
    <>
      <RowGroup>
        <ExportRow />
        <DiagnosticsRow />
      </RowGroup>
      <RowGroup>
        <DeleteChatsRow />
        <DeleteAllMemoriesRow />
      </RowGroup>
    </>
  );
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;

function ExportRow() {
  const t = useT();
  const [bytes, setBytes] = useState(0);
  const exportData = useExportData(setBytes);
  const busy = exportData.isPending;
  return (
    <Row
      label={t.exportData}
      hint={
        <span aria-live="polite">
          {busy ? (bytes ? t.exportingBytes(kb(bytes)) : t.exporting) : t.exportHint}
        </span>
      }
    >
      {({ labelId }) => (
        <Button
          size="sm"
          aria-describedby={labelId}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => {
            setBytes(0);
            exportData.mutate(undefined, { onSuccess: ({ name, bytes: size }) => notify("success", t.exported, `${name} · ${kb(size)}`), onError: notifyError });
          }}
        >
          {busy ? <Spinner /> : <Download aria-hidden />}
          {busy ? t.exporting : t.export}
        </Button>
      )}
    </Row>
  );
}

/** For asking for help: what runs, what's set up, recent server logs. Redacted on the server. */
function DiagnosticsRow() {
  const t = useT();
  const copy = useCopyDiagnostics();
  const download = useDownloadDiagnostics();
  return (
    <Row label={t.diagnostics} hint={t.diagnosticsHint}>
      {({ labelId }) => (
        <>
          <Button
            size="sm"
            aria-describedby={labelId}
            disabled={copy.isPending}
            onClick={() => copy.mutate(undefined, { onSuccess: () => notify("success", t.diagnosticsCopied), onError: notifyError })}
          >
            {copy.isPending ? <Spinner /> : <ClipboardCopy aria-hidden />}
            {t.copyDiagnostics}
          </Button>
          <Button size="sm" variant="ghost" aria-describedby={labelId} disabled={download.isPending} onClick={() => download.mutate(undefined, { onError: notifyError })}>
            {download.isPending ? <Spinner /> : <Download aria-hidden />}
            {t.download}
          </Button>
        </>
      )}
    </Row>
  );
}

function DeleteChatsRow() {
  const t = useT();
  const threads = useThreads();
  const remove = useDeleteAllThreads();
  return (
    <Row label={t.deleteAllChats}>
      {({ labelId }) => (
        <Confirm
          trigger={
            <Button size="sm" variant="danger" aria-describedby={labelId} disabled={threads.data?.length === 0}>
              <Trash2 aria-hidden />
              {t.deleteAll}
            </Button>
          }
          title={t.deleteAllChatsConfirm}
          description={t.deleteAllChatsHint}
          confirmLabel={t.deleteAll}
          onConfirm={() => remove.mutateAsync().then(({ deleted }) => notify("success", t.deletedChats(deleted)), notifyError)}
        />
      )}
    </Row>
  );
}
