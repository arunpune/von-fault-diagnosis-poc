// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Re-records the golden parity runs.
//
//   node --conditions=@fdp/source tools/eval/scripts/refresh-parity-golden.ts
//
// It builds `services/modbus/Dockerfile` (both targets) and
// `infra/mosquitto/Dockerfile`, replays the `parity-feb01` slice through the
// real machine and the real gateway twice — once clean and once with
// `oil_cooler_fouling` — and writes what the gateway published into
// `data/fixtures/metropt3/golden/`, together with the sim image id and the
// SHA-256 of `injections.json` that produced it.
//
// The noise case has no recording: `motor_overload` is compared statistically
// and over a whole day of cycling, which is the Docker parity test's job and
// not something a stored sample list would make faster.
//
// The recordings carry sample values derived from MetroPT-3, and no MetroPT-3
// row is committed, so they stay out of this repository: the directory they
// land in is ignored by version control, `test/replay/golden.test.ts` skips
// when they are absent, and the Docker parity test — which needs no recording
// at all — stays the authority. Run this when the Go engine, the register map
// or the injection catalog changes, and again before reading a golden failure
// as a defect.
//
// It exits 0 when both were written, 1 on any failure and 2 when the machine
// cannot run the stack at all (no Docker, no cut slice, no ground truth).

import process from "node:process";

import { toIsoMs } from "@fdp/contracts";

import { PARITY_SLICE, requireSlice, sliceDef } from "../src/slices.ts";
import type {
  InjectRequest,
  ParityGolden,
  ParityImages,
  SimStack,
} from "../test/helpers/sim-stack.ts";
import {
  UNIT_ID,
  alarmRegistryProvenance,
  buildParityImages,
  goldenPath,
  imageDigest,
  injectionsSha256,
  parityBlocker,
  recordParityRun,
  startSimStack,
  writeGolden,
} from "../test/helpers/sim-stack.ts";

/** Simulated seconds per wall-clock second: two hours of recording in two seconds. */
const REPLAY_SPEED = 3600;

const EXIT_FAILURE = 1;
const EXIT_UNAVAILABLE = 2;

/** The two recordings, and the injection each is made with. */
const RECORDINGS: readonly { readonly name: string; readonly injection?: InjectRequest }[] = [
  { name: "clean" },
  {
    name: "oil-cooler",
    injection: {
      injection_id: "oil_cooler_fouling",
      params: { magnitude: 1, duration_sim_min: 60 },
    },
  },
];

function say(message: string): void {
  process.stdout.write(`refresh-parity-golden: ${message}\n`);
}

/** Records one run on a stack of its own and writes it. */
async function record(
  images: ParityImages,
  csvPath: string,
  entry: { name: string; injection?: InjectRequest },
): Promise<void> {
  say(`starting the stack for "${entry.name}"`);
  const stack: SimStack = await startSimStack({ images, csvPath, replaySpeed: REPLAY_SPEED });
  try {
    const run = await recordParityRun(stack, entry.injection);
    if (run.samples.length === 0) {
      throw new Error("the gateway published no sample; the recording would be empty");
    }
    if (entry.injection !== undefined && run.startedSimTsMs === undefined) {
      throw new Error("the simulator reported no injection start on gt/#");
    }

    const document: ParityGolden = {
      schema: "urn:fdp:eval:parity-golden:v1",
      recorded: {
        recorded_at: toIsoMs(new Date()),
        sim_image_digest: imageDigest(images.sim),
        injections_sha256: injectionsSha256(),
        alarm_registry: alarmRegistryProvenance(),
        slice: PARITY_SLICE,
        slice_sha256: sliceDef(PARITY_SLICE).sha256,
        replay_speed: REPLAY_SPEED,
        unit_id: UNIT_ID,
      },
      injection:
        entry.injection === undefined || run.startedSimTsMs === undefined
          ? null
          : { ...entry.injection, started_sim_ts: toIsoMs(new Date(run.startedSimTsMs)) },
      samples: run.samples,
    };
    writeGolden(entry.name, document);
    say(
      `wrote ${goldenPath(entry.name)}: ${run.samples.length} samples in ${run.batches} batches` +
        (run.instanceId === undefined ? "" : `, instance ${run.instanceId}`),
    );
  } catch (error) {
    process.stderr.write(`${await stack.tail()}\n`);
    throw error;
  } finally {
    await stack.stop();
  }
}

async function main(): Promise<number> {
  const blocker = await parityBlocker();
  if (blocker !== undefined) {
    say(`cannot record: ${blocker}`);
    return EXIT_UNAVAILABLE;
  }

  let csvPath: string;
  try {
    csvPath = requireSlice(PARITY_SLICE);
  } catch (error) {
    say(`cannot record: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_UNAVAILABLE;
  }

  say("building the sim, gateway and broker images");
  const images = await buildParityImages();
  say(`sim ${images.sim} (${imageDigest(images.sim)})`);
  if (!images.brokerHasAcl) {
    say("infra/mosquitto is absent; recording against an anonymous broker");
  }

  for (const entry of RECORDINGS) {
    await record(images, csvPath, entry);
  }
  say(`injections.json sha256 ${injectionsSha256()}`);
  const registry = alarmRegistryProvenance();
  say(`alarm registry ${registry.source} sha256 ${registry.sha256}`);
  say(
    `recorded ${RECORDINGS.length} runs; they are ignored by version control, as every MetroPT-3 row is`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `refresh-parity-golden: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = EXIT_FAILURE;
}
