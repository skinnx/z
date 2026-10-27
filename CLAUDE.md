# z

- `packages/core/src/contract.ts` defines every type and HTTP route shared by server, plugins and web. Change it first, then both sides.
- Packages are consumed as TypeScript source (no build step); import local files with `.ts` extensions. TypeScript is 7.x (native `tsc`).
- AI SDK is v7: `instructions` (not `system`), `isStepCount`, native tool approvals (`needsApproval`). Check `node_modules/ai/dist/index.d.ts` before using an API from memory.
- Web: use the wrappers in `apps/web/src/ui` (Base UI underneath) and lucide icons; no page titles/subtitles — the layout leads with the screen's primary action.
- Checks: `pnpm typecheck`, `pnpm --filter @z/web build`.
