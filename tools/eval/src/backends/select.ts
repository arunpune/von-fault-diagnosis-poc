// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Which backends a run compares, and how each is reached.
//
// `--backends` names them (default `rules,jev`). The rules baseline is always
// the pipeline's twin. Jev's mode follows `EVAL_JEV_MODE`: an explicit mode is
// taken as asked, and `auto` walks this order —
//
//   live      when TYPESAFE_API_KEY is set
//   cassette  when cassettes exist for the run's model
//   mock      otherwise
//
// — taking the first mode that applies *and* that this checkout can build
// (`AVAILABLE_JEV_MODES`; all three today). The LLM runs live or not
// at all: named in `--backends` without `LLM_API_KEY`, it is dropped with a
// warning and never built.
//
// **No live call without consent.** Once the modes are chosen and
// before any handle is built, a run with a live backend is planned: its
// scenarios are replayed once against the contracts' mock (`plan.ts`) and the
// planned calls and estimated cost of every live backend are logged. Without
// `--confirm-live` the selection then stops with a configuration error that
// repeats the plan, so the run exits 1 having called nothing.
//
// Every choice is logged with its reason and never with a key: the reason says
// *that* a key is set, the value never leaves `EvalSecrets`.

import { ConfigError } from "../config.ts";
import type { BackendName, EvalConfig, JevMode } from "../config.ts";
import { HELDOUT_PROFILE } from "../heldout.ts";
import { createLogger } from "../log.ts";
import type { Logger } from "../log.ts";
import { CASSETTES_DIR, CassetteStore } from "./cassette.ts";
import { createJevHandle } from "./jev.ts";
import type { ResolvedJevMode } from "./jev.ts";
import { createLlmHandle } from "./llm.ts";
import type { MockOptions } from "./mock.ts";
import { planLiveRun } from "./plan.ts";
import type { LiveBackendName, LivePlan, LivePlanRow } from "./plan.ts";
import { createRulesHandle } from "./rules.ts";
import type { BackendHandle, HandleDeps } from "./types.ts";

export { CASSETTES_DIR } from "./cassette.ts";

/** The Jev modes this checkout can build. */
export const AVAILABLE_JEV_MODES: ReadonlySet<ResolvedJevMode> = new Set<ResolvedJevMode>([
  "live",
  "cassette",
  "mock",
]);

/** What `auto` looks at. */
export interface JevModeFacts {
  /** True when `TYPESAFE_API_KEY` is set; the value itself is never looked at here. */
  readonly hasKey: boolean;
  /** Recorded answers on disk for the run's model. */
  readonly cassettes: number;
}

/** The mode Jev runs in, why, and which preferred modes were passed over on the way. */
export interface JevModeChoice {
  readonly mode: ResolvedJevMode;
  readonly reason: string;
  /** Modes that applied but are not available in this checkout. */
  readonly passedOver: readonly ResolvedJevMode[];
}

/** Plans the live calls of a run before any is made. */
export type LivePlanner = (cfg: EvalConfig, live: readonly LiveBackendName[]) => Promise<LivePlan>;

/** What selecting the backends needs beyond the configuration. */
export interface SelectDeps extends HandleDeps {
  /** Where the choices are logged; the harness logger on stderr by default. */
  readonly log?: Logger;
  /** The cassette root; `CASSETTES_DIR` by default. */
  readonly cassettesDir?: string;
  /** How a mock-mode Jev answers; `best-overlap` by default. */
  readonly mock?: MockOptions;
  /** How a run with a live backend is planned; a mock replay of its scenarios by default. */
  readonly plan?: LivePlanner;
}

/** How many recorded answers exist for `model` under `root`. */
export function cassetteCount(model: string, root: string = CASSETTES_DIR): number {
  return CassetteStore.forModel(model, root).count;
}

/**
 * Resolves `EVAL_JEV_MODE` into the mode a run uses.
 *
 * An explicit mode is returned as asked; whether it can be built is `createJevHandle`'s
 * question, and it answers with an error rather than a silent substitute. `auto` takes the
 * first mode of the auto order that applies and is in `available`.
 */
export function resolveJevMode(
  requested: JevMode,
  facts: JevModeFacts,
  model: string,
  available: ReadonlySet<ResolvedJevMode> = AVAILABLE_JEV_MODES,
): JevModeChoice {
  if (requested !== "auto") {
    return { mode: requested, reason: `EVAL_JEV_MODE=${requested}`, passedOver: [] };
  }

  const order: readonly { mode: ResolvedJevMode; applies: boolean; why: string }[] = [
    { mode: "live", applies: facts.hasKey, why: "TYPESAFE_API_KEY is set" },
    {
      mode: "cassette",
      applies: facts.cassettes > 0,
      why: `${facts.cassettes} cassette(s) exist for ${model}`,
    },
    { mode: "mock", applies: true, why: "no key and no cassettes" },
  ];

  const passedOver: ResolvedJevMode[] = [];
  const skipped: string[] = [];
  for (const option of order) {
    if (!option.applies) continue;
    if (available.has(option.mode)) {
      const why = skipped.length === 0 ? option.why : `${skipped.join("; ")}; using ${option.mode}`;
      return { mode: option.mode, reason: `EVAL_JEV_MODE=auto: ${why}`, passedOver };
    }
    passedOver.push(option.mode);
    skipped.push(`${option.why}, but ${option.mode} mode is not available in this checkout`);
  }
  throw new Error(`EVAL_JEV_MODE=auto: none of ${[...available].join(", ")} applies`);
}

/** One backend of the run as chosen, before anything is built. */
type Choice =
  | { readonly name: "rules"; readonly reason: string }
  | { readonly name: "jev"; readonly mode: ResolvedJevMode; readonly reason: string }
  | { readonly name: "llm"; readonly reason: string };

/** The backend a choice reaches a live API with, if it does. */
function liveName(choice: Choice): LiveBackendName | undefined {
  if (choice.name === "llm") return "llm";
  if (choice.name === "jev" && choice.mode === "live") return "jev";
  return undefined;
}

/** How one named backend will run, or `undefined` when it is dropped (the LLM without a key). */
function choose(
  name: BackendName,
  cfg: EvalConfig,
  deps: SelectDeps,
  log: Logger,
): Choice | undefined {
  switch (name) {
    case "rules":
      return { name, reason: "the rules baseline always runs in process" };
    case "jev": {
      const facts: JevModeFacts = {
        hasKey: cfg.secrets.typesafeApiKey !== undefined,
        cassettes: cassetteCount(cfg.jevModel, deps.cassettesDir),
      };
      const choice = resolveJevMode(cfg.jevMode, facts, cfg.jevModel);
      if (choice.passedOver.length > 0) {
        log.warn("jev mode passed over", { passed_over: choice.passedOver, reason: choice.reason });
      }
      return { name, mode: choice.mode, reason: choice.reason };
    }
    case "llm":
      if (cfg.secrets.llmApiKey === undefined) {
        log.warn("llm backend dropped", {
          reason:
            "--backends names llm, but LLM_API_KEY is not set; the llm backend runs live only",
        });
        return undefined;
      }
      return { name, reason: "--backends names llm and LLM_API_KEY is set" };
  }
}

/** A plan row as one sentence, for the refusal and the log. */
function planSentence(row: LivePlanRow): string {
  return (
    `${row.backend} (${row.model}): ${row.calls} planned call(s), ` +
    `≈ ${row.inputTokens} input and ${row.outputTokens} output tokens, ` +
    `≈ USD ${row.usd.toFixed(6)} at the prices of ${row.pricesAsOf}`
  );
}

/**
 * Plans the live backends of the run, logs the plan and refuses without `--confirm-live`.
 *
 * @throws ConfigError on `--confirm-live` when the run did not give it, after the plan was
 * logged; the message repeats the plan.
 */
async function confirmLive(
  cfg: EvalConfig,
  live: readonly LiveBackendName[],
  planner: LivePlanner,
  log: Logger,
): Promise<void> {
  if (cfg.profile === HELDOUT_PROFILE && !cfg.confirmLive) {
    // The plan is a mock replay of the run's scenarios. The held-out set is replayed by its one
    // final run and by nothing else, so it is never planned for a run that would stop here.
    throw new ConfigError(
      "--confirm-live",
      "the held-out set's one run is live and is confirmed up front; it is never planned by a " +
        "mock replay that does not go on to run",
    );
  }
  const plan = await planner(cfg, live);
  for (const row of plan.rows) {
    log.warn("live plan", {
      backend: row.backend,
      model: row.model,
      calls: row.calls,
      usage: `≈ ${row.inputTokens} in, ${row.outputTokens} out`,
      cost_usd: row.usd,
      prices_as_of: row.pricesAsOf,
      scenarios: plan.scenarios,
      // The plan replays at the run's own persistence: N moves which decisions are asked,
      // and the tuning list is recorded once per N (the Jev thresholds pre-registration).
      persist_sim_min: cfg.persistSimMin,
      confirmed: cfg.confirmLive,
    });
  }
  if (cfg.confirmLive) return;
  throw new ConfigError(
    "--confirm-live",
    `this run calls a live API (${plan.rows.map(planSentence).join("; ")}, estimated from a mock ` +
      `replay of ${plan.scenarios} scenario(s) at GATE_PERSIST_SIM_MIN ${cfg.persistSimMin}); ` +
      "nothing was called: re-run with --confirm-live to make these calls",
  );
}

/**
 * `--resample` rotates recorded answers, so it means something only to a Jev replayed from
 * cassettes. Anywhere else it would be silently ignored, and a run that said "resample 2" while
 * serving live or mock answers would be mislabelled; it is refused before anything is built.
 *
 * @throws ConfigError on `--resample` when it is above 0 and Jev does not run in cassette mode.
 */
function requireCassetteForResample(cfg: EvalConfig, choices: readonly Choice[]): void {
  if ((cfg.resample ?? 0) === 0) return;
  const jev = choices.find((choice) => choice.name === "jev");
  if (jev?.name === "jev" && jev.mode === "cassette") return;
  const where = jev?.name === "jev" ? `Jev runs in ${jev.mode} mode` : "the run does not name jev";
  throw new ConfigError(
    "--resample",
    `${cfg.resample} rotates Jev's recorded answers and needs Jev in cassette mode ` +
      `(EVAL_JEV_MODE=cassette), but ${where}`,
  );
}

/** Builds one chosen backend's handle, logging the mode it runs in. */
async function build(
  choice: Choice,
  cfg: EvalConfig,
  deps: SelectDeps,
  log: Logger,
): Promise<BackendHandle> {
  let handle: BackendHandle;
  switch (choice.name) {
    case "rules":
      handle = createRulesHandle(deps);
      break;
    case "jev":
      handle = await createJevHandle(cfg, choice.mode, deps, deps.mock);
      break;
    case "llm":
      handle = createLlmHandle(cfg);
      break;
  }
  log.info("decision backend", {
    backend: handle.name,
    mode: handle.mode,
    model: handle.model,
    reason: choice.reason,
  });
  return handle;
}

/**
 * The handles of every backend `--backends` names, in that order, less a dropped LLM.
 *
 * A run with a live backend is planned first and refused without `--confirm-live`. If a
 * backend cannot be built, the ones already started are closed before the error propagates, so
 * a failed selection never leaves a server listening.
 *
 * @throws ConfigError when every named backend was dropped, when a live run lacks
 * `--confirm-live`, or when the configuration cannot drive the mode a backend resolved to.
 */
export async function selectBackends(cfg: EvalConfig, deps: SelectDeps): Promise<BackendHandle[]> {
  const log = deps.log ?? createLogger();
  const choices = cfg.backends.flatMap((name) => choose(name, cfg, deps, log) ?? []);
  if (choices.length === 0) {
    throw new ConfigError(
      "--backends",
      `every backend it names was dropped (${cfg.backends.join(", ")})`,
    );
  }
  requireCassetteForResample(cfg, choices);
  const live = choices.flatMap((choice) => liveName(choice) ?? []);
  if (live.length > 0) await confirmLive(cfg, live, deps.plan ?? planLiveRun, log);

  const handles: BackendHandle[] = [];
  try {
    for (const choice of choices) handles.push(await build(choice, cfg, deps, log));
  } catch (error) {
    await closeBackends(handles);
    throw error;
  }
  return handles;
}

/** Closes every handle, whatever happened to the others. */
export async function closeBackends(handles: readonly BackendHandle[]): Promise<void> {
  await Promise.allSettled(handles.map((handle) => handle.close()));
}
