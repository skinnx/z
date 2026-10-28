import type { Settings } from "@z/core";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useDeleteAllMemories, useMemories } from "../../api/memories.ts";
import { useSaveSetting } from "../../api/settings.ts";
import { useT } from "../../i18n.ts";
import { cn } from "../../lib/cn.ts";
import { Confirm } from "../../ui/alert-dialog.tsx";
import { Button } from "../../ui/button.tsx";
import { Dialog } from "../../ui/dialog.tsx";
import { Textarea } from "../../ui/field.tsx";
import { Row, RowGroup, useAutosaveText } from "../../ui/row.tsx";
import { Switch } from "../../ui/switch.tsx";
import { notify, notifyError } from "../../ui/toast.tsx";
import { MemoryManager } from "./memories.tsx";
import { PanelState } from "./state.tsx";

const PERSONA_MAX = 4000;

export function PersonalizationPanel() {
  return (
    <PanelState>
      {(s) => (
        <>
          <RowGroup>
            <PersonaRow value={s.persona} />
          </RowGroup>
          <MemoryRows settings={s} />
        </>
      )}
    </PanelState>
  );
}

function PersonaRow({ value }: { value: string }) {
  const t = useT();
  const { save, saved } = useSaveSetting();
  const text = useAutosaveText(value, (persona) => save({ persona }));
  const near = text.draft.length > PERSONA_MAX * 0.9;
  return (
    <Row label={t.customInstructions} hint={t.customInstructionsHint} saved={saved} stack>
      {({ labelId, hintId }) => (
        <div className="flex w-full flex-col gap-1">
          <Textarea
            aria-labelledby={labelId}
            aria-describedby={hintId}
            value={text.draft}
            onChange={(e) => text.change(e.currentTarget.value)}
            onBlur={text.flush}
            placeholder={t.personaPlaceholder}
            maxLength={PERSONA_MAX}
            rows={5}
          />
          <span aria-live="polite" className={cn("self-end text-xs tabular-nums", near ? "text-warn" : "text-fg-muted")}>
            <span className="sr-only">{t.characters}: </span>
            {t.charCount(text.draft.length, PERSONA_MAX)}
          </span>
        </div>
      )}
    </Row>
  );
}

function MemoryRows({ settings }: { settings: Settings }) {
  const t = useT();
  const { save, saved } = useSaveSetting();
  const memories = useMemories();
  const [managing, setManaging] = useState(false);
  const count = memories.data?.length;
  return (
    <RowGroup label={t.memories}>
      <Row label={t.memorySwitch} hint={t.memorySwitchHint} saved={saved}>
        {({ labelId, hintId }) => (
          <Switch aria-labelledby={labelId} aria-describedby={hintId} checked={settings.memory} onCheckedChange={(memory) => save({ memory })} />
        )}
      </Row>
      <Row label={t.manageMemories} hint={count === undefined ? t.loading : t.memoryCount(count)}>
        {({ labelId }) => (
          <Dialog.Root open={managing} onOpenChange={setManaging}>
            <Dialog.Trigger render={<Button size="sm" aria-describedby={labelId} />}>{t.manage}</Dialog.Trigger>
            <Dialog.Content wide title={t.memories}>
              <MemoryManager />
            </Dialog.Content>
          </Dialog.Root>
        )}
      </Row>
      <DeleteAllMemoriesRow />
    </RowGroup>
  );
}

/** Also offered under Data controls. */
export function DeleteAllMemoriesRow() {
  const t = useT();
  const remove = useDeleteAllMemories();
  const memories = useMemories();
  return (
    <Row label={t.deleteAllMemories}>
      {({ labelId }) => (
        <Confirm
          trigger={
            <Button size="sm" variant="danger" aria-describedby={labelId} disabled={memories.data?.length === 0}>
              <Trash2 aria-hidden />
              {t.deleteAll}
            </Button>
          }
          title={t.deleteAllMemoriesConfirm}
          description={t.deleteAllMemoriesHint}
          confirmLabel={t.deleteAll}
          onConfirm={() =>
            remove.mutateAsync().then(
              ({ deleted }) => notify("success", t.deletedMemories(deleted)),
              notifyError,
            )
          }
        />
      )}
    </Row>
  );
}
