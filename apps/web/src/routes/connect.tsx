import type { ConnectorAuth, ConnectorInput, ConnectorPreset, ConnectorTool, ConnectorView, Risk } from "@z/core";
import { Form } from "@base-ui/react/form";
import { Ban, BookOpen, Briefcase, Cable, Check, ChevronDown, ClipboardPaste, CodeXml, ExternalLink, Info, Layers, Pencil, Plus, RefreshCw, RotateCcw, Search, ShieldAlert, SlidersHorizontal, Trash2, Users, type LucideIcon } from "lucide-react";
import { memo, startTransition, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  connectorInput,
  useCompleteOAuth,
  useConnectOAuth,
  useConnectorPresets,
  useConnectors,
  useDeleteConnector,
  useRefreshConnector,
  useSaveConnector,
  useSetConnectorEnabled,
  useSetToolRisk,
} from "../api/connectors.ts";
import { ErrorFix } from "../components/error-fix.tsx";
import { BulkPolicyMenu, effectivePolicy, QuickCheckRow, ToolPolicyRow, usePolicyList, type Policy, type PolicyTool } from "../components/tool-policy.tsx";
import { connectorFailure } from "../lib/errors.ts";
import { createMenuHandle, MenuItem, MenuSeparator, MenuTrigger, SharedMenu, type MenuHandle } from "../ui/menu.tsx";
import { useT } from "../i18n.ts";
import { cn } from "../lib/cn.ts";
import { authIcon, CATEGORIES, statusDot as dot, fillTemplate, headerValue, isSecretName, placeholders, presetOf, templateParts, uniqueId, urlHost } from "../lib/connectors.ts";
import { slug } from "../lib/format.ts";
import { useStable } from "../lib/use-stable.ts";
import { riskIcon } from "../lib/icons.tsx";
import { Confirm } from "../ui/alert-dialog.tsx";
import { Monogram } from "../ui/avatar.tsx";
import { Button, ExternalLinkButton, Tile } from "../ui/button.tsx";
import { Badge, Card, Loading, LoadError, Section, Spinner } from "../ui/card.tsx";
import { Collapsible } from "../ui/collapsible.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Input } from "../ui/field.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { Page } from "../ui/page.tsx";
import { Switch, SwitchRow } from "../ui/switch.tsx";
import { createTooltipHandle, SharedTooltip, type TooltipHandle } from "../ui/tooltip.tsx";
import { notify, notifyError } from "../ui/toast.tsx";
import { Segmented } from "../ui/toggle-group.tsx";
import { serverText } from "../lib/server-text.ts";

type Editing = { preset: ConnectorPreset | null; connector: ConnectorView | null };

const categoryIcon: Record<ConnectorPreset["category"], LucideIcon> = { docs: BookOpen, dev: CodeXml, work: Briefcase, aggregator: Layers };

export default function Connect() {
  const t = useT();
  const presets = useConnectorPresets();
  const connectors = useConnectors();
  const refresh = useRefreshConnector();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const handled = useRef("");

  // Back from OAuth (`?connector=<id>` or `&error=…`), or a deep link from the command menu (`?open=<id>`).
  useEffect(() => {
    const id = params.get("connector") ?? params.get("open");
    const error = params.get("error");
    if ((!id && !error) || connectors.isPending) return;
    const key = params.toString();
    if (handled.current === key) return;
    handled.current = key;
    if (params.has("connector") || error) {
      const label = connectors.data?.find((c) => c.id === id)?.label ?? id ?? "";
      if (error) notify("error", t.oauthFailed, label ? `${label}: ${error}` : error);
      else notify("success", t.oauthDone, label);
      if (id) refresh.mutate(id, { onError: () => void connectors.refetch() });
    }
    if (id) setFocusId(id);
    setParams({}, { replace: true });
  }, [params, setParams, connectors, refresh, t]);

  const list = connectors.data ?? [];
  // The open dialog follows live updates (status after sign-in, refreshed tools).
  const live = editing?.connector ? (list.find((c) => c.id === editing.connector?.id) ?? editing.connector) : null;

  return (
    <Page title={t.nav_connect}>
      {presets.isPending || connectors.isPending ? (
        <Loading label={t.loading} className="h-64" />
      ) : connectors.error && !connectors.data ? (
        <LoadError error={connectors.error} onRetry={() => void connectors.refetch()} />
      ) : (
        <>
          {/* Your own connectors first; the catalog to add more follows. */}
          {list.length > 0 && (
            <Section label={t.connectedSources} icon={<Cable aria-hidden />}>
              <ul className="flex flex-col gap-3">
                {list.map((c) => (
                  <li key={c.id}>
                    <ConnectorCard
                      connector={c}
                      focus={focusId === c.id}
                      onFocused={() => setFocusId(null)}
                      onEdit={() => setEditing({ preset: presetOf(c, presets.data ?? []) ?? null, connector: c })}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {presets.error && !presets.data && <LoadError error={presets.error} onRetry={() => void presets.refetch()} />}
          <Gallery
            presets={presets.data ?? []}
            connectors={list}
            onPick={(preset) => setEditing({ preset, connector: null })}
            onOpen={(c) => setEditing({ preset: presetOf(c, presets.data ?? []) ?? null, connector: c })}
          />
        </>
      )}

      <Dialog.Root open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <Dialog.Content
          wide
          title={
            editing && (
              <>
                <Monogram text={editing.connector?.label ?? (editing.preset?.url ? editing.preset.label : "+")} className="size-7 rounded-lg text-[0.6875rem] normal-case" />
                <span className="truncate">{editing.connector?.label ?? (editing.preset?.url ? editing.preset.label : t.customServer)}</span>
              </>
            )
          }
        >
          {editing && (
            <ConnectorForm
              key={editing.connector ? `edit:${editing.connector.id}` : `new:${editing.preset?.id ?? "custom"}`}
              preset={editing.preset}
              connector={live}
              onSaved={(c) => setEditing((e) => (e ? { ...e, connector: c } : e))}
              onDone={() => setEditing(null)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>
    </Page>
  );
}

/** The catalog as tappable tiles, by category, ending with "any MCP server". */
function Gallery({
  presets,
  connectors,
  onPick,
  onOpen,
}: {
  presets: ConnectorPreset[];
  connectors: ConnectorView[];
  onPick: (p: ConnectorPreset | null) => void;
  /** A preset that is already connected opens that connector instead of adding a duplicate. */
  onOpen: (c: ConnectorView) => void;
}) {
  const t = useT();
  const byHost = useMemo(() => new Map(connectors.map((c) => [urlHost(c.urlDisplay), c])), [connectors]);
  // The catalog's URL-less entry is "any MCP server": it gets its own tile at the end.
  const custom = presets.find((p) => !p.url) ?? null;
  const groups = CATEGORIES.map((cat) => ({ cat, items: presets.filter((p) => p.category === cat && p.url) })).filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-6">
      {groups.map(({ cat, items }) => {
        const Icon = categoryIcon[cat];
        return (
          <Section key={cat} label={t[`cat_${cat}`]} icon={<Icon aria-hidden />}>
            <ul className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
              {items.map((p) => {
                // Templated URLs ({owner}/{repo}) can be connected many times over; fixed ones once.
                const existing = placeholders(p.url).length === 0 ? byHost.get(urlHost(p.url)) : undefined;
                return (
                  <li key={p.id} className="min-w-0">
                    <PresetTile preset={p} connected={byHost.has(urlHost(p.url))} onClick={() => (existing ? onOpen(existing) : onPick(p))} />
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      })}
      <Section label={t.cat_custom} icon={<Plus aria-hidden />}>
        <ul className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
          <li className="min-w-0 sm:col-span-2 md:col-span-1">
            <Tile onClick={() => onPick(custom)} className="border-dashed border-line-strong">
              <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
                <Plus className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{t.customServer}</span>
                <span className="block truncate text-xs text-fg-muted">{t.customServerMeta}</span>
              </span>
            </Tile>
          </li>
        </ul>
      </Section>
    </div>
  );
}

function PresetTile({ preset: p, connected, onClick }: { preset: ConnectorPreset; connected: boolean; onClick: () => void }) {
  const t = useT();
  const Auth = authIcon[p.auth];
  return (
    <Tile onClick={onClick}>
      <Monogram text={p.label} className="size-9 rounded-lg text-xs normal-case" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={p.label}>
            {p.label}
          </span>
          {connected && (
            <>
              <Check aria-hidden className="size-3.5 shrink-0 text-ok" />
              <span className="sr-only">, {t.alreadyConnected}</span>
            </>
          )}
        </span>
        <span className="block truncate font-mono text-xs text-fg-muted" title={urlHost(p.url)}>
          {urlHost(p.url)}
        </span>
      </span>
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-subtle text-fg-muted" title={t[`auth_${p.auth}`]}>
        <Auth aria-hidden className="size-3.5" />
        <span className="sr-only">, {t[`auth_${p.auth}`]}</span>
      </span>
    </Tile>
  );
}

/** `hideDetail`: the fix below the line already shows the server's words. */
function StatusLine({ connector: c, hideDetail, className }: { connector: ConnectorView; hideDetail?: boolean; className?: string }) {
  const t = useT();
  return (
    <p className={cn("flex items-start gap-2 text-xs", className)} aria-live="polite">
      <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", dot[c.status])} />
      <span className="min-w-0 break-words">
        <span className={cn("font-medium", c.status === "error" ? "text-danger" : c.status === "needs_auth" ? "text-warn" : "text-fg")}>{t[`cst_${c.status}`]}</span>
        {c.statusDetail && !hideDetail && <span className="text-fg-muted"> · {serverText(c.statusDetail, c.statusDetailMsg)}</span>}
      </span>
    </p>
  );
}

/** While a sign-in is pending: finish it by pasting the address the browser ended on, for installs the provider can't redirect back to. */
function PasteCallback({ connector: c, className }: { connector: ConnectorView; className?: string }) {
  const t = useT();
  const complete = useCompleteOAuth();
  const [url, setUrl] = useState("");
  if (!c.signInPending && !complete.isPending) return null;
  const submit = () => {
    if (!url.trim() || complete.isPending) return;
    complete.mutate(
      { id: c.id, url },
      {
        onSuccess: () => {
          setUrl("");
          notify("success", t.oauthDone, c.label);
        },
        onError: notifyError,
      },
    );
  };
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Field label={t.pasteCallbackLabel} description={t.pasteCallbackHint}>
        <Input
          value={url}
          onValueChange={setUrl}
          placeholder="http://localhost:8787/oauth/callback?code=…&state=…"
          className="font-mono text-xs"
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
        />
      </Field>
      <Button size="sm" className="self-end" disabled={!url.trim() || complete.isPending} onClick={submit}>
        {complete.isPending ? <Spinner /> : <ClipboardPaste aria-hidden />}
        {t.pasteCallbackSubmit}
      </Button>
    </div>
  );
}

function needsSignIn(c: ConnectorView) {
  return c.status === "needs_auth" || (c.auth === "oauth" && c.enabled && !c.oauth?.connected);
}

function ConnectorCard({ connector: c, focus, onFocused, onEdit }: { connector: ConnectorView; focus: boolean; onFocused: () => void; onEdit: () => void }) {
  const t = useT();
  const setEnabled = useSetConnectorEnabled();
  const refresh = useRefreshConnector();
  const remove = useDeleteConnector();
  const oauth = useConnectOAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();

  useEffect(() => {
    if (!focus) return;
    setOpen(c.tools.length > 0);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    ref.current?.focus({ preventScroll: true });
    onFocused();
  }, [focus, c.tools.length, onFocused]);

  const failure = connectorFailure(c);
  const busy = refresh.isPending || c.status === "connecting";

  return (
    <article ref={ref} tabIndex={-1} aria-labelledby={headingId} className="scroll-mt-6 rounded-(--radius-card) outline-none focus-visible:ring-2 focus-visible:ring-accent">
    <Card className={cn(!c.enabled && "bg-bg")}>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <div className="flex items-start gap-3 p-4">
          <span className="relative shrink-0">
            <Monogram text={c.label} className="normal-case" />
            <span aria-hidden className={cn("absolute -end-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-surface", dot[c.status])} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id={headingId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-semibold" title={c.label}>
                {c.label}
              </span>
              {c.public && (
                <Badge tone="warn">
                  <Users aria-hidden />
                  {t.publicBadge}
                </Badge>
              )}
            </h3>
            <p className="truncate font-mono text-xs text-fg-muted" title={c.urlDisplay}>
              {c.urlDisplay}
            </p>
            <StatusLine connector={c} hideDetail={Boolean(failure)} className="mt-1.5" />
            {failure && (
              <ErrorFix
                variant="inline"
                className="mt-2"
                kind={failure}
                error={c.statusDetail ?? ""}
                errorMsg={c.statusDetailMsg}
                provider={{ id: c.id, label: c.label }}
                source={c.label}
                pending={oauth.isPending}
                onSignIn={() => oauth.mutate(c.id, { onError: notifyError })}
                onFixKey={onEdit}
                onRetry={c.enabled ? () => refresh.mutate(c.id, { onError: notifyError }) : undefined}
              />
            )}
            {c.server && (
              <p className="mt-1 truncate text-xs text-fg-muted">
                {c.server.name} <span className="font-mono">{c.server.version}</span>
              </p>
            )}
          </div>
          <Switch
            aria-label={`${t.enabled}: ${c.label}`}
            checked={c.enabled}
            disabled={setEnabled.isPending}
            onCheckedChange={(enabled) => setEnabled.mutate({ connector: c, enabled })}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1.5 ps-3">
          {c.tools.length > 0 ? (
            <Collapsible.Trigger className="text-sm">{t.toolCount(c.tools.length)}</Collapsible.Trigger>
          ) : (
            <span className="text-xs text-fg-muted">{c.status === "connected" ? t.noToolsListed : t.toolsAfterConnect}</span>
          )}
          <div className="ms-auto flex items-center gap-1">
            <IconButton
              label={`${t.refresh}: ${c.label}`}
              size="icon-sm"
              disabled={refresh.isPending || !c.enabled}
              onClick={() => refresh.mutate(c.id, { onError: notifyError })}
            >
              <RefreshCw aria-hidden className={cn(busy && "motion-safe:animate-spin")} />
            </IconButton>
            <IconButton label={`${t.edit}: ${c.label}`} size="icon-sm" onClick={onEdit}>
              <Pencil aria-hidden />
            </IconButton>
            <Confirm
              trigger={
                <IconButton label={`${t.delete}: ${c.label}`} size="icon-sm">
                  <Trash2 aria-hidden />
                </IconButton>
              }
              title={t.deleteConnectorConfirm(c.label)}
              description={t.deleteConnectorHint}
              confirmLabel={t.delete}
              onConfirm={() => remove.mutateAsync(c.id).catch(notifyError)}
            />
          </div>
        </div>

        {c.signInPending && <PasteCallback connector={c} className="border-t border-line p-4" />}

        <Collapsible.Panel>
          <ToolList connector={c} />
        </Collapsible.Panel>
      </Collapsible.Root>
    </Card>
    </article>
  );
}

const RISKS = ["read", "write", "external"] as const satisfies readonly Risk[];
/** Aggregators can list hundreds of tools: search past this many, render a page at a time. */
const SEARCH_FROM = 8;
const PAGE = 40;

/** Rows rendered with the first paint of an opened list; the rest of the page follows when there is time. */
const FIRST_ROWS = 8;

function ToolList({ connector: c }: { connector: ConnectorView }) {
  const t = useT();
  const policies = usePolicyList();
  const { approvals } = policies;
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  // Each key shows in the box at once; filtering and re-rendering the rows follow when there is time.
  const q = useDeferredValue(query).trim().toLowerCase();
  // Opening the list paints its first rows straight away and renders the rest of the page right after.
  const rendered = useDeferredValue(limit, FIRST_ROWS);
  const haystack = useMemo(() => c.tools.map((x) => `${x.name} ${x.title ?? ""} ${x.description}`.toLowerCase()), [c.tools]);
  const matches = useMemo(() => (q ? c.tools.filter((_, i) => haystack[i]!.includes(q)) : c.tools), [c.tools, haystack, q]);
  const hidden = useMemo(() => c.tools.filter((x) => effectivePolicy(x.risk, approvals[x.toolName]) === "deny").length, [c.tools, approvals]);
  const shown = matches.slice(0, Math.min(limit, rendered));
  const policyTools = useMemo(() => c.tools.map(policyTool), [c.tools]);
  const save = useSaveConnector();
  const setRisk = useSetToolRisk();
  // Rows get one stable callback; the connector it reads is always the current one.
  const onSetRisk = useStable((tool: string, risk: Risk | null) => setRisk.mutate({ connector: c, tool, risk }, { onError: notifyError }));
  // One menu and one tooltip for every row (each row only has their triggers).
  const [riskMenu] = useState(() => createMenuHandle<ConnectorTool>());
  const [tooltips] = useState(() => createTooltipHandle());

  return (
    <div className="border-t border-line">
      <div className="flex flex-col gap-2 px-4 pt-3 pb-1">
        {c.tools.length > SEARCH_FROM && (
          <div className="flex items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden className="pointer-events-none absolute start-3 top-3 size-4 text-fg-muted" />
              <Input
                type="search"
                aria-label={t.searchTools(c.label)}
                placeholder={t.searchTools(c.label)}
                value={query}
                onValueChange={(v) => {
                  setQuery(v);
                  setLimit(PAGE);
                }}
                className="ps-9"
              />
            </div>
            <span aria-live="polite" className="shrink-0 text-xs text-fg-muted tabular-nums">
              {q ? t.toolsMatching(matches.length, c.tools.length) : t.toolCount(c.tools.length)}
            </span>
          </div>
        )}
        <div className="flex items-start gap-2">
          <p className="flex min-w-0 flex-1 items-start gap-1.5 pt-1.5 text-xs text-fg-muted">
            <Ban aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>
              {t.neverHint}
              {hidden > 0 && <span className="font-medium text-fg"> {t.toolsHidden(hidden)}</span>}
            </span>
          </p>
          <BulkPolicyMenu
            source={c.label}
            tools={policyTools}
            onMarkAllRead={() =>
              save.mutate(connectorInput(c, { risks: { ...c.risks, ...Object.fromEntries(c.tools.map((x) => [x.name, "read" as const])) } }), {
                onSuccess: () => notify("success", t.bulkDone(c.label)),
                onError: notifyError,
              })
            }
          />
        </div>
      </div>
      {matches.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-4 text-sm text-fg-muted">
          {t.noToolMatch}
          <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
            {t.clearSearch}
          </Button>
        </div>
      ) : (
        <ul aria-label={t.toolsOf(c.label)} className="divide-y divide-line">
          {shown.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              policy={approvals[tool.toolName]}
              saved={policies.savedKey === tool.toolName}
              onPolicyChange={policies.setPolicy}
              riskMenu={riskMenu}
              tooltips={tooltips}
            />
          ))}
        </ul>
      )}
      <SharedTooltip handle={tooltips} />
      <SharedMenu handle={riskMenu}>
        {(tool) => (
          <>
            {RISKS.map((r) => {
              const Icon = riskIcon[r];
              return (
                <MenuItem key={r} icon={<Icon aria-hidden className="size-4" />} onClick={() => r !== tool.risk && onSetRisk(tool.name, r)}>
                  <span className="flex-1">{t.treatAs(t[`riskPhrase_${r}`])}</span>
                  {r === tool.risk && <Check aria-hidden className="size-4 text-accent-text" />}
                </MenuItem>
              );
            })}
            {tool.riskSource === "user" && (
              <>
                <MenuSeparator />
                <MenuItem icon={<RotateCcw aria-hidden className="size-4" />} onClick={() => onSetRisk(tool.name, null)}>
                  {t.resetRisk}
                </MenuItem>
              </>
            )}
          </>
        )}
      </SharedMenu>
      {matches.length > limit && (
        <div className="border-t border-line px-2 py-1.5">
          <Button size="sm" variant="ghost" onClick={() => startTransition(() => setLimit((n) => n + PAGE))}>
            <ChevronDown aria-hidden />
            {t.showMore(Math.min(PAGE, matches.length - limit), matches.length - limit)}
          </Button>
        </div>
      )}
      <div className="border-t border-line px-4">
        <QuickCheckRow />
      </div>
    </div>
  );
}

const policyTool = (tool: ConnectorTool): PolicyTool => ({ key: tool.toolName, name: tool.title || tool.name, risk: tool.risk });

/**
 * One tool: the shared approval row, plus the trigger of the list's menu to correct what the server
 * says the tool does. Memoised per tool.
 */
const ToolRow = memo(function ToolRow({
  tool,
  policy,
  saved,
  onPolicyChange,
  riskMenu,
  tooltips,
}: {
  tool: ConnectorTool;
  policy: Policy | undefined;
  saved: boolean;
  onPolicyChange: (key: string, value: Policy) => void;
  riskMenu: MenuHandle<ConnectorTool>;
  tooltips: TooltipHandle;
}) {
  const t = useT();
  const denied = effectivePolicy(tool.risk, policy) === "deny";
  const name = tool.title || tool.name;
  const asPolicyTool = useMemo(() => policyTool(tool), [tool]);
  return (
    <ToolPolicyRow
      as="li"
      // Rows out of view skip layout and paint until scrolled to.
      className="px-4 [content-visibility:auto] [contain-intrinsic-size:auto_5.5rem]"
      tool={asPolicyTool}
      policy={policy}
      saved={saved}
      onPolicyChange={onPolicyChange}
      description={tool.description}
      code={tool.title ? tool.name : undefined}
      badges={
        <>
          {tool.riskSource === "user" && (
            <Badge tone="accent" className="h-5">
              {t.rsrc_user}
            </Badge>
          )}
          {denied && (
            <Badge tone="danger" className="h-5">
              <Ban aria-hidden />
              {t.toolHidden}
            </Badge>
          )}
        </>
      }
      menu={
        <MenuTrigger
          handle={riskMenu}
          payload={tool}
          trigger={
            <IconButton label={`${t.editRisk}: ${name}`} size="icon-sm" tooltipHandle={tooltips}>
              <SlidersHorizontal aria-hidden />
            </IconButton>
          }
        />
      }
    />
  );
});

type HeaderRow = { name: string; value: string; stored: boolean };

function ConnectorForm({
  preset,
  connector,
  onSaved,
  onDone,
}: {
  preset: ConnectorPreset | null;
  connector: ConnectorView | null;
  onSaved: (c: ConnectorView) => void;
  onDone: () => void;
}) {
  const t = useT();
  const save = useSaveConnector();
  const oauth = useConnectOAuth();
  const taken = (useConnectors().data ?? []).map((c) => c.id);
  const editing = connector !== null;
  const template = !editing && preset && placeholders(preset.url).length > 0 ? preset.url : null;
  const presetHeader = preset?.header ? { ...preset.header, template: stripName(preset.header.template, preset.header.name) } : null;

  const [vars, setVars] = useState<Record<string, string>>({});
  const [url, setUrl] = useState(!editing && preset && !template ? preset.url : "");
  const [labelDraft, setLabelDraft] = useState<string | null>(connector?.label ?? null);
  const [idDraft, setIdDraft] = useState<string | null>(connector?.id ?? null);
  const [transport, setTransport] = useState<"http" | "sse">(connector?.transport ?? preset?.transport ?? "http");
  const [auth, setAuth] = useState<ConnectorAuth>(connector?.auth ?? preset?.auth ?? "none");
  const [headers, setHeaders] = useState<HeaderRow[]>(() => {
    const stored = connector?.headerKeys ?? [];
    if (stored.length) return stored.map((name) => ({ name, value: "", stored: true }));
    return [{ name: presetHeader?.name ?? "Authorization", value: "", stored: false }];
  });
  const [isPublic, setPublic] = useState(connector?.public ?? false);

  // Until the user types their own, the label names what the URL points at (e.g. "GitMCP vercel/ai").
  const shown = template ? placeholders(template).filter((n) => !isSecretName(n)).map((n) => vars[n]?.trim()).filter(Boolean) : [];
  // A custom server is named after its host until the user names it.
  const label = labelDraft ?? (preset?.url ? [preset.label, shown.join("/")].filter(Boolean).join(" ") : isHttpUrl(url.trim()) ? urlHost(url.trim()) : "");
  const id = idDraft ?? uniqueId(slug(label) || preset?.id || "", taken);
  const idValid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
  const idTaken = !editing && taken.includes(id);
  const finalUrl = template ? fillTemplate(template, vars) : url.trim();
  const missingVars = template ? placeholders(template).some((n) => !vars[n]?.trim()) : false;
  const urlOk = editing ? true : !!finalUrl && !missingVars && isHttpUrl(finalUrl);
  const formId = useId();
  // Some presets take an optional key without being "headers" auth (e.g. Context7's higher rate limits).
  const showHeaders = auth === "headers" || (auth === "none" && (!!presetHeader || (connector?.headerKeys.length ?? 0) > 0));

  const submit = () => {
    if (!idValid || idTaken || !urlOk || !label.trim()) return;
    const input: ConnectorInput = {
      id,
      label: label.trim(),
      transport,
      auth,
      enabled: connector?.enabled ?? true,
      public: isPublic,
      risks: connector?.risks ?? {},
      ...(finalUrl ? { url: finalUrl } : {}),
    };
    if (showHeaders) {
      // Per key: a typed value sets it, "" removes a stored one, anything left blank keeps what is stored.
      const patch: Record<string, string> = {};
      for (const h of headers) {
        const name = h.name.trim();
        if (name && h.value) patch[name] = presetHeader && name === presetHeader.name ? headerValue(presetHeader.template, h.value) : h.value;
      }
      for (const name of connector?.headerKeys ?? []) if (!headers.some((h) => h.stored && h.name === name)) patch[name] = "";
      if (Object.keys(patch).length) input.headers = patch;
    } else if (connector?.headerKeys.length) {
      input.headers = {};
    }
    save.mutate(input, {
      onSuccess: (c) => {
        setHeaders((rows) => rows.map((h) => (h.value ? { ...h, value: "", stored: true } : h)));
        if (needsSignIn(c) || c.status === "error") {
          // Stay: the next step (sign in, or fix what failed) is right here.
          onSaved(c);
          return;
        }
        notify("success", t.saved, `${c.label} · ${t.toolCount(c.tools.length)}`);
        onDone();
      },
      onError: notifyError,
    });
  };

  return (
    <Form
      id={formId}
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {connector && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-subtle px-3 py-2.5">
          <StatusLine connector={connector} className="min-w-0 flex-1" />
          {connector.auth === "oauth" && (
            <Button
              variant={needsSignIn(connector) ? "primary" : "secondary"}
              size="sm"
              disabled={oauth.isPending}
              onClick={() => oauth.mutate(connector.id, { onError: notifyError })}
            >
              {oauth.isPending ? <Spinner /> : <ExternalLink aria-hidden />}
              {needsSignIn(connector) ? t.connect : t.signInAgain}
            </Button>
          )}
          {connector.auth === "oauth" && <PasteCallback connector={connector} className="basis-full" />}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.label}>
          <Input required value={label} maxLength={64} onValueChange={setLabelDraft} />
        </Field>
        <Field label={t.id} description={editing ? undefined : t.connectorIdHint(idValid ? id : "id")} error={!idValid ? t.idInvalid : idTaken ? t.idTaken : undefined}>
          <Input
            required
            disabled={editing}
            value={id}
            maxLength={32}
            onValueChange={(v) => setIdDraft(v.toLowerCase())}
            spellCheck={false}
            className="font-mono text-sm"
          />
        </Field>
      </div>

      {template ? (
        <TemplateUrl template={template} values={vars} onChange={setVars} />
      ) : (
        <Field label={t.serverUrl} description={editing ? t.urlKeepHint : t.urlSecretHint}>
          <Input
            type="url"
            required={!editing}
            value={url}
            onValueChange={setUrl}
            placeholder={connector?.urlDisplay ?? "https://…/mcp"}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-sm"
          />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        <div className="flex flex-col gap-1.5">
          <span aria-hidden className="text-sm font-medium">
            {t.transport}
          </span>
          <Segmented<"http" | "sse">
            label={t.transport}
            value={transport}
            onChange={setTransport}
            className="h-10 w-full sm:w-auto"
            options={[
              { value: "http", label: "HTTP" },
              { value: "sse", label: "SSE" },
            ]}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span aria-hidden className="text-sm font-medium">
            {t.authLabel}
          </span>
          <Segmented<ConnectorAuth>
            label={t.authLabel}
            value={auth}
            onChange={setAuth}
            className="h-10 w-full"
            options={(["none", "headers", "oauth"] as const).map((a) => {
              const Icon = authIcon[a];
              return { value: a, label: t[`authShort_${a}`], icon: <Icon aria-hidden />, ariaLabel: t[`auth_${a}`] };
            })}
          />
        </div>
      </div>

      {showHeaders && <HeaderFields rows={headers} onChange={setHeaders} preset={presetHeader} required={auth === "headers"} />}
      {auth === "oauth" && !connector && (
        <p className="flex items-start gap-2 text-sm text-fg-muted">
          <ExternalLink aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t.oauthAfterSave}
        </p>
      )}

      {preset?.note && (
        <p role="note" className="flex items-start gap-2.5 rounded-lg border border-line bg-subtle px-3 py-2.5 text-sm">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-accent-text" />
          <span className="min-w-0">{preset.note}</span>
        </p>
      )}

      <div className="flex flex-col gap-1">
        <SwitchRow label={t.publicTools} hint={t.publicWarn} checked={isPublic} onCheckedChange={setPublic} />
        {isPublic && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-warn">
            <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
            {t.publicOn}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {preset?.docsUrl && <ExternalLinkButton href={preset.docsUrl}>{t.docs}</ExternalLinkButton>}
        <Button type="submit" variant="primary" className="ms-auto" disabled={save.isPending || !idValid || idTaken || !urlOk || !label.trim()}>
          {save.isPending ? <Spinner /> : editing ? <Check aria-hidden /> : <Cable aria-hidden />}
          {save.isPending ? t.connecting : editing ? t.save : t.saveAndConnect}
        </Button>
      </div>
    </Form>
  );
}

/** The preset URL with an inline field per `{placeholder}`. */
function TemplateUrl({ template, values, onChange }: { template: string; values: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const t = useT();
  const legend = useId();
  return (
    <fieldset aria-labelledby={legend} className="flex flex-col gap-1.5">
      <span id={legend} className="text-sm font-medium">
        {t.serverUrl}
      </span>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-lg border border-control bg-subtle px-3 py-2 font-mono text-sm">
        {templateParts(template).map((part, i) =>
          "text" in part ? (
            <span key={i} className="break-all text-fg-muted">
              {part.text}
            </span>
          ) : (
            <Input
              key={i}
              aria-label={part.name}
              required
              placeholder={part.name}
              type={isSecretName(part.name) ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={values[part.name] ?? ""}
              onValueChange={(v) => onChange({ ...values, [part.name]: v })}
              className="h-8 w-auto min-w-20 flex-1 basis-24 font-mono text-sm"
            />
          ),
        )}
      </div>
      <p className="text-xs text-fg-muted">{t.urlSecretHint}</p>
    </fieldset>
  );
}

function HeaderFields({
  rows,
  onChange,
  preset,
  required,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  preset: { name: string; template: string; label: string } | null;
  required: boolean;
}) {
  const t = useT();
  const update = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">{t.auth_headers}</legend>
      {rows.map((row, i) => {
        const fromPreset = preset && row.name === preset.name;
        return (
          <div
            key={i}
            className={cn("grid gap-3 sm:items-start", fromPreset ? "sm:grid-cols-[minmax(0,1fr)_auto]" : "sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]")}
          >
            {/* The preset already names its header; only the secret is asked for. */}
            {!fromPreset && (
              <Field label={t.headerName}>
                <Input value={row.name} disabled={row.stored} onValueChange={(v) => update(i, { name: v })} spellCheck={false} placeholder="Authorization" className="font-mono text-sm" />
              </Field>
            )}
            <Field
              label={fromPreset ? preset.label : t.headerValue}
              description={row.stored ? t.keepSecret : fromPreset && !/^\{[^{}]+\}$/.test(preset.template) ? t.headerSent(`${preset.name}: ${preset.template}`) : undefined}
            >
              <Input
                type="password"
                autoComplete="off"
                required={required && !row.stored && i === 0}
                value={row.value}
                onValueChange={(v) => update(i, { value: v })}
                placeholder={row.stored ? "••••••••" : required && i === 0 ? t.required : t.optional}
                spellCheck={false}
                className="font-mono text-sm"
              />
            </Field>
            {rows.length > 1 && (
              <IconButton label={`${t.remove}: ${row.name || t.headerName}`} className="sm:mt-6.5" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden />
              </IconButton>
            )}
          </div>
        );
      })}
      <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange([...rows, { name: "", value: "", stored: false }])}>
        <Plus aria-hidden />
        {t.addHeader}
      </Button>
    </fieldset>
  );
}

/** Presets may write the template as `Authorization: Bearer {token}`; the value is what follows the name. */
function stripName(template: string, name: string): string {
  const prefix = `${name.toLowerCase()}:`;
  return template.toLowerCase().startsWith(prefix) ? template.slice(prefix.length).trim() : template;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
