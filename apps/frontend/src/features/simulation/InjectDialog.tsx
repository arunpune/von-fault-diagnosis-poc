// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The parameters of one injection before it starts: a slider per tunable parameter of the
// definition, set to its default within its bounds, and the length of the instance in simulated
// time, set to the definition's default. "Inject" hands the arguments back; the menu sends them.
// The form lives inside the dialog's content, which unmounts when the dialog closes, so every
// opening starts from the catalog's defaults.

import { useId, useMemo, useState, type FormEvent } from "react";

import type { InjectArgs, InjectionDef, ParamDef } from "@/api/types";
import { Code } from "@/components/common/Code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import {
  durationSteps,
  fmtParam,
  fmtSimMinutes,
  injectArgs,
  paramStep,
  tunableParams,
} from "@/features/simulation/inject-params";
import { humanize } from "@/lib/format";

export interface InjectDialogProps {
  /** The injection chosen last; kept while the dialog closes so its content can animate out. */
  entry: InjectionDef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInject: (entry: InjectionDef, args: InjectArgs) => void;
}

export function InjectDialog({ entry, open, onOpenChange, onInject }: InjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {entry === null ? null : (
        <DialogContent>
          <InjectForm key={entry.injection_id} entry={entry} onInject={onInject} />
        </DialogContent>
      )}
    </Dialog>
  );
}

interface InjectFormProps {
  entry: InjectionDef;
  onInject: (entry: InjectionDef, args: InjectArgs) => void;
}

function InjectForm({ entry, onInject }: InjectFormProps) {
  const params = useMemo(() => tunableParams(entry), [entry]);
  const durations = useMemo(
    () => durationSteps(entry.default_duration_sim_min),
    [entry.default_duration_sim_min],
  );
  const [values, setValues] = useState<ReadonlyMap<string, number>>(
    () => new Map(params.map((param) => [param.name, param.default])),
  );
  const [durationIndex, setDurationIndex] = useState(() =>
    durations.indexOf(entry.default_duration_sim_min),
  );
  const durationSimMin = durations[durationIndex] ?? entry.default_duration_sim_min;

  function setParam(name: string, value: number): void {
    setValues((current) => new Map(current).set(name, value));
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onInject(entry, injectArgs(entry, values, durationSimMin));
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Inject {entry.label}</DialogTitle>
        <DialogDescription>{entry.description}</DialogDescription>
      </DialogHeader>
      <p className="flex items-center gap-2 text-muted-foreground">
        <span>Fault</span>
        <Code value={entry.fault_id} />
        {entry.benign ? (
          <Badge variant="outline" className="rounded-sm">
            benign
          </Badge>
        ) : null}
      </p>
      {params.map((param) => (
        <ParamSlider
          key={param.name}
          param={param}
          value={values.get(param.name) ?? param.default}
          onChange={setParam}
        />
      ))}
      <LabelledSlider
        label="Duration in sim time"
        valueText={fmtSimMinutes(durationSimMin)}
        min={0}
        max={durations.length - 1}
        step={1}
        value={durationIndex}
        onChange={setDurationIndex}
      />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit">Inject</Button>
      </DialogFooter>
    </form>
  );
}

interface ParamSliderProps {
  param: ParamDef;
  value: number;
  onChange: (name: string, value: number) => void;
}

function ParamSlider({ param, value, onChange }: ParamSliderProps) {
  const step = paramStep(param);
  return (
    <LabelledSlider
      label={humanize(param.name)}
      valueText={fmtParam(value, step)}
      min={param.min}
      max={param.max}
      step={step}
      value={value}
      onChange={(next) => onChange(param.name, next)}
    />
  );
}

interface LabelledSliderProps {
  label: string;
  valueText: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}

function LabelledSlider({
  label,
  valueText,
  min,
  max,
  step,
  value,
  onChange,
}: LabelledSliderProps) {
  const labelId = useId();
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <span id={labelId}>{label}</span>
        <span aria-hidden="true" className="tabular-nums">
          {valueText}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined) {
            onChange(next);
          }
        }}
        thumbProps={{ "aria-labelledby": labelId, "aria-valuetext": valueText }}
      />
    </div>
  );
}
