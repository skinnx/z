# z

- Every type and HTTP route shared by server, plugins and web lives in `packages/core/src/contract/<domain>.ts` (routes next to their types), re-exported by the `contract.ts` barrel; add new modules there, shared primitives in `contract/common.ts`. Change it first, then both sides.
- Packages are consumed as TypeScript source (no build step); import local files with `.ts` extensions. TypeScript is 7.x (native `tsc`).
- AI SDK is v7: `instructions` (not `system`), `isStepCount`, call-level async `toolApproval`. Check `node_modules/ai/dist/index.d.ts` before using an API from memory.
- Approvals run sensitive-data guard → safety floor → per-tool policy → reviewer (`packages/core/src/tools.ts`, `approvals.ts`). Channel bots only ever get `public` read tools.
- Migrations in `apps/server/src/db.ts` are named (`NNNN-name`) and recorded in `schema_migrations`; append only, never edit, rename or reorder one that has shipped.
- Web: use the wrappers in `apps/web/src/ui` (Base UI underneath), AI Elements in `apps/web/src/components/ai-elements`, and lucide icons; no page titles/subtitles — the layout leads with the screen's primary action. Strings live in `apps/web/src/i18n.ts` (en + vi).
- nightly-labs/openbot is PolyForm Noncommercial: borrow ideas only, never code. CopilotKit/OpenDuet and AI Elements code may be adapted with their notices.
- Checks: `pnpm typecheck`, `pnpm test`, `pnpm --filter @z/web build`.
