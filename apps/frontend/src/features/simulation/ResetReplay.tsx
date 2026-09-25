// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// "Reset replay": a quiet button, because a reset throws away the episodes in progress, behind
// a confirmation that says so. Only the confirmation's own "Reset replay" sends
// `POST /api/sim/reset`; Cancel, Escape and a click outside send nothing.

import RotateCcwIcon from "lucide-react/dist/esm/icons/rotate-ccw";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSimAction } from "@/features/simulation/use-sim-action";
import { tid } from "@/lib/testids";

const RESET_ICON = <RotateCcwIcon aria-hidden="true" />;

export function ResetReplay() {
  const [confirming, setConfirming] = useState(false);
  const { run, pending } = useSimAction();

  function reset(): void {
    setConfirming(false);
    run({ cmd: "reset", args: {} }, { success: "Replay reset" });
  }

  return (
    <Dialog open={confirming} onOpenChange={setConfirming}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={pending}
          data-testid={tid.sim.reset}
        >
          {RESET_ICON}
          Reset replay
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset replay</DialogTitle>
          <DialogDescription>
            Reset the replay to the start of the dataset? Open episodes are aborted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={reset}>
            Reset replay
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
