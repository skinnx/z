import { Meter as BaseMeter } from "@base-ui/react/meter";
import { cn } from "../lib/cn.ts";

export function Meter({ value, max, label, valueText }: { value: number; max: number; label: string; valueText: string }) {
  const ratio = max > 0 ? value / max : 0;
  return (
    <BaseMeter.Root value={Math.min(value, max)} max={max} getAriaValueText={() => valueText} className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1.5">
      <BaseMeter.Label className="text-xs text-fg-muted">{label}</BaseMeter.Label>
      <span className="text-xs tabular-nums text-fg">{valueText}</span>
      <BaseMeter.Track className="col-span-2 h-1.5 overflow-hidden rounded-full bg-subtle">
        <BaseMeter.Indicator
          className={cn("rounded-full transition-[width] duration-500", ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warn" : "bg-accent")}
        />
      </BaseMeter.Track>
    </BaseMeter.Root>
  );
}
