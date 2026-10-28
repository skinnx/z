import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { Skill, SkillInput } from "@z/core";
import { api } from "./client.ts";
import { keys, queryClient } from "./query.ts";

const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name);

export const skillsQuery = queryOptions({ queryKey: keys.skills, queryFn: () => api<Skill[]>("/skills"), staleTime: 60_000 });

export function useSkills() {
  return useQuery(skillsQuery);
}

export function useSaveSkill() {
  return useMutation({
    mutationFn: ({ id, ...input }: SkillInput & { id?: string }) =>
      id ? api<Skill>(`/skills/${encodeURIComponent(id)}`, { method: "PUT", body: input }) : api<Skill>("/skills", { body: input }),
    onSuccess: (skill) =>
      queryClient.setQueryData<Skill[]>(keys.skills, (list) => [...(list ?? []).filter((s) => s.id !== skill.id), skill].sort(byName)),
  });
}

export function useDeleteSkill() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_, id) => queryClient.setQueryData<Skill[]>(keys.skills, (list) => list?.filter((s) => s.id !== id)),
  });
}

/** `/name rest` → the skill and the rest, when `name` is a known skill (mirrors the server's `invokedSkill`). */
export function splitSkill(text: string, skills: readonly Skill[] | undefined): { skill: Skill; rest: string } | null {
  const match = /^\s*\/([a-z0-9][a-z0-9-]*)(?=\s|$)\s*([\s\S]*)$/.exec(text);
  const skill = match && skills?.find((s) => s.name === match[1]);
  return skill ? { skill, rest: match[2]!.trim() } : null;
}
