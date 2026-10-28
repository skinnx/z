import { useMutation, useQuery } from "@tanstack/react-query";
import type { LoginInput, LoginUpdate, LoginView } from "@z/core";
import { api } from "./client.ts";
import { queryClient, upsert } from "./query.ts";

const key = ["logins"] as const;

export function useLogins() {
  return useQuery({ queryKey: key, queryFn: () => api<LoginView[]>("/logins") });
}

const put = (login: LoginView) => queryClient.setQueryData<LoginView[]>(key, (list) => upsert(list, login, false));

export function useSaveLogin() {
  return useMutation({
    mutationFn: ({ id, ...body }: (LoginInput | LoginUpdate) & { id?: string }) =>
      id ? api<LoginView>(`/logins/${encodeURIComponent(id)}`, { method: "PUT", body }) : api<LoginView>("/logins", { body }),
    onSuccess: put,
  });
}

export function useDeleteLogin() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/logins/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) => queryClient.setQueryData<LoginView[]>(key, (list) => list?.filter((l) => l.id !== id)),
  });
}
