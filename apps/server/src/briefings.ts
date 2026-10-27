/** Daily briefing: generation, storage and the cron that triggers it. */
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { generateBriefing, type Briefing } from "@z/core";
import { clip, notify } from "./notify.ts";
import type { Runtime } from "./runtime.ts";

export type Briefings = ReturnType<typeof createBriefings>;

export function createBriefings(rt: Runtime) {
  let job: Cron | null = null;
  let inFlight: Promise<Briefing> | null = null;

  async function generate(): Promise<Briefing> {
    const last = rt.store.briefings.latest();
    const since = last ? new Date(last.createdAt) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const draft = await generateBriefing({ ...rt.deps("briefing"), tasks: rt.store.tasks.list(), since });
    const briefing: Briefing = { id: randomUUID(), ...draft, createdAt: new Date().toISOString() };
    rt.store.briefings.insert(briefing);
    rt.bus.emit({ type: "briefing", briefing });
    notify({ kind: "briefing", title: "Your briefing", body: clip(briefing.summary, 300), path: "/" });
    return briefing;
  }

  return {
    /** Concurrent requests share one generation. */
    generate(): Promise<Briefing> {
      inFlight ??= generate().finally(() => (inFlight = null));
      return inFlight;
    },

    /** (Re)schedule from current settings. */
    schedule() {
      job?.stop();
      const { briefingCron, timezone } = rt.store.settings.get();
      try {
        job = new Cron(briefingCron, { timezone, protect: true }, () => {
          this.generate().catch((error) => console.error(`[z] scheduled briefing failed: ${error instanceof Error ? error.message : error}`));
        });
      } catch (error) {
        job = null;
        console.error(`[z] invalid briefing schedule "${briefingCron}" (${timezone})`);
      }
    },

    stop() {
      job?.stop();
    },
  };
}
