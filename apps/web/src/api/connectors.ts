import { useMutation, useQuery } from "@tanstack/react-query";
import type { ConnectorInput, ConnectorPreset, ConnectorView, Risk } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient, upsert } from "./query.ts";

const path = (id: string) => `/connectors/${encodeURIComponent(id)}`;
const put = (c: ConnectorView) => queryClient.setQueryData<ConnectorView[]>(keys.connectors, (list) => upsert(list, c, false));

/** The static catalog shipped with z. */
export function useConnectorPresets() {
  return useQuery({ queryKey: keys.connectorPresets, queryFn: () => api<ConnectorPreset[]>("/connector-presets"), staleTime: Infinity });
}

export function useConnectors() {
  return useQuery({ queryKey: keys.connectors, queryFn: () => api<ConnectorView[]>("/connectors") });
}

/** Saves, connects and lists tools; can take a few seconds. */
export function useSaveConnector() {
  return useMutation({
    mutationFn: (input: ConnectorInput) => api<ConnectorView>(path(input.id), { method: "PUT", body: input }),
    onSuccess: put,
  });
}

/** Override one tool's risk (`null` returns it to the server's hint), shown at once and rolled back on failure. */
export function useSetToolRisk() {
  return useMutation({
    mutationFn: ({ connector, tool, risk }: { connector: ConnectorView; tool: string; risk: Risk | null }) => {
      const { [tool]: _dropped, ...rest } = connector.risks;
      return api<ConnectorView>(path(connector.id), { method: "PUT", body: connectorInput(connector, { risks: risk ? { ...rest, [tool]: risk } : rest }) });
    },
    onMutate: async ({ connector, tool, risk }) => {
      await queryClient.cancelQueries({ queryKey: keys.connectors });
      const previous = queryClient.getQueryData<ConnectorView[]>(keys.connectors);
      if (risk) {
        const next: ConnectorView = {
          ...connector,
          risks: { ...connector.risks, [tool]: risk },
          tools: connector.tools.map((x) => (x.name === tool ? { ...x, risk, riskSource: "user" } : x)),
        };
        queryClient.setQueryData<ConnectorView[]>(keys.connectors, (list) => upsert(list, next, false));
      }
      return { previous };
    },
    onError: (_e, _v, ctx) => queryClient.setQueryData(keys.connectors, ctx?.previous),
    onSuccess: put,
  });
}

export function useDeleteConnector() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(path(id), { method: "DELETE" }),
    onSuccess: (_, id) => queryClient.setQueryData<ConnectorView[]>(keys.connectors, (list) => list?.filter((c) => c.id !== id)),
  });
}

export function useRefreshConnector() {
  return useMutation({
    mutationFn: (id: string) => api<ConnectorView>(`${path(id)}/refresh`, { method: "POST" }),
    onSuccess: put,
  });
}

/**
 * Start OAuth. The tab opens synchronously inside the click (popup blockers only allow that)
 * and is pointed at the authorization URL once the server answers; blocked → this tab goes.
 */
export function useConnectOAuth() {
  return useMutation({
    mutationFn: async (id: string) => {
      const tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
      try {
        const { authorizationUrl } = await api<{ authorizationUrl: string }>(`${path(id)}/oauth`, { method: "POST" });
        if (tab && !tab.closed) tab.location.href = authorizationUrl;
        else window.location.assign(authorizationUrl);
        return authorizationUrl;
      } catch (e) {
        tab?.close();
        throw e;
      }
    },
  });
}

/** A PUT body that keeps what a view can't carry (URL, header values) as stored. */
export function connectorInput(c: ConnectorView, patch: Partial<ConnectorInput> = {}): ConnectorInput {
  return { id: c.id, label: c.label, transport: c.transport, auth: c.auth, enabled: c.enabled, public: c.public, risks: c.risks, ...patch };
}
