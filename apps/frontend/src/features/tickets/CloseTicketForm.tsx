// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The technician's verdict on a ticket: was the diagnosis correct or wrong, with an optional note,
// posted as `{ verdict, note? }` to `POST /api/tickets/:id/close`. Open tickets and review tickets
// both take a verdict. The button stays disabled until a verdict is chosen. `useCloseTicket`
// patches the ticket caches with the closed ticket the backend answers — the sheet then shows the
// closure record and the ticket moves from its list to the closed one — and says
// "Ticket #<id> closed as correct"; a refused or failed close says what failed and leaves the form
// as it was, so it can be sent again.

import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { useCloseTicket } from "@/api/mutations";
import type { TicketVerdict } from "@/api/types";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { shortId } from "@/lib/format";
import { tid } from "@/lib/testids";

export interface CloseTicketFormProps {
  ticketId: string;
}

interface VerdictOption {
  value: TicketVerdict;
  label: string;
  hint: string;
  testId: string;
}

const VERDICT_OPTIONS: readonly VerdictOption[] = [
  {
    value: "correct",
    label: "Correct",
    hint: "The fault on this ticket is what you found.",
    testId: tid.tickets.closeCorrect,
  },
  {
    value: "wrong",
    label: "Wrong",
    hint: "The machine had a different problem, or none.",
    testId: tid.tickets.closeWrong,
  },
];

function isVerdict(value: string): value is TicketVerdict {
  return VERDICT_OPTIONS.some((option) => option.value === value);
}

function failureMessage(ticketId: string, error: Error): string {
  return `Couldn't close ticket #${shortId(ticketId)}: ${error.message}`;
}

function VerdictChoice({ option, disabled }: { option: VerdictOption; disabled: boolean }) {
  const itemId = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3">
      <RadioGroupItem
        id={itemId}
        value={option.value}
        disabled={disabled}
        aria-describedby={hintId}
        data-testid={option.testId}
        className="mt-0.5"
      />
      <div className="grid gap-0.5">
        <label htmlFor={itemId} className="text-sm font-medium">
          {option.label}
        </label>
        <p id={hintId} className="text-[0.8125rem] text-muted-foreground">
          {option.hint}
        </p>
      </div>
    </div>
  );
}

export function CloseTicketForm({ ticketId }: CloseTicketFormProps) {
  const [verdict, setVerdict] = useState<TicketVerdict | null>(null);
  const [note, setNote] = useState("");
  const close = useCloseTicket();
  const questionId = useId();
  const noteId = useId();
  const pending = close.isPending;

  function handleVerdictChange(value: string): void {
    if (isVerdict(value)) {
      setVerdict(value);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (verdict === null || pending) {
      return;
    }
    close.mutate(
      { ticketId, verdict, note },
      { onError: (error) => toast.error(failureMessage(ticketId, error)) },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-3">
        <p id={questionId} className="text-sm">
          Was the diagnosis right?
        </p>
        <RadioGroup
          aria-labelledby={questionId}
          value={verdict ?? ""}
          onValueChange={handleVerdictChange}
          className="gap-3"
        >
          {VERDICT_OPTIONS.map((option) => (
            <VerdictChoice key={option.value} option={option} disabled={pending} />
          ))}
        </RadioGroup>
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={noteId} className="text-sm font-medium">
          Note <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id={noteId}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={pending}
          placeholder="What did you find, and what did you do?"
          className="max-w-[72ch]"
        />
      </div>
      <Button
        type="submit"
        disabled={verdict === null || pending}
        data-testid={tid.tickets.closeSubmit}
      >
        {pending ? "Closing…" : "Close ticket"}
      </Button>
    </form>
  );
}
