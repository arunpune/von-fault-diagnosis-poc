// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// One simulator control's command. Each control owns its own mutation, so the play button is busy
// only while its own request is in flight, not while a jump is. The acknowledged status reaches
// the live store through `useSimCommand`'s default `applyAck` before any callback here runs; this
// hook adds the two things the control says: the success toast in the button's own verb, and a
// sentence for every failure.

import { useCallback } from "react";
import { toast } from "sonner";

import { useSimCommand, type SimCommandRequest } from "@/api/mutations";
import { commandErrorSentence } from "@/features/simulation/command-errors";

export interface SimActionOptions {
  /** Toasted once the simulator applied the command: "Jumped to Air leak – 5 Jun 2020". */
  success?: string;
  /** Runs once the command succeeded or failed, e.g. to let go of a slider's draft value. */
  onSettled?: () => void;
}

export interface SimAction {
  /** Sends the command; never throws, failures become a toast. */
  run: (request: SimCommandRequest, options?: SimActionOptions) => void;
  /** True while this control's command waits for its acknowledgement. */
  pending: boolean;
}

export function useSimAction(): SimAction {
  const { mutate, isPending } = useSimCommand();
  const run = useCallback(
    (request: SimCommandRequest, { success, onSettled }: SimActionOptions = {}) => {
      mutate(request, {
        onSuccess: () => {
          if (success !== undefined) {
            toast.success(success);
          }
        },
        onError: (error) => {
          toast.error(commandErrorSentence(error));
        },
        onSettled,
      });
    },
    [mutate],
  );
  return { run, pending: isPending };
}
