// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

/**
 * Signal roles: what detection calls the tags it reads.
 *
 * Detection never writes a tag literal. The manual owns the tag ids and may
 * rename them, while the recording's column names are fixed for ever. So the
 * mapping runs the other way round: every role names the MetroPT-3 column it
 * describes, `resolveRoles` looks that column up in the register map, and the
 * rest of `detection/` addresses signals by role and emits the register map's
 * `signal_id`s. Rename a tag and nothing here changes.
 *
 * The ambient temperature has no column: the simulator adds it and the
 * register map carries it as the one `group: "extra"` signal.
 *
 * Digital polarity: the register map has no `invert` field, because the
 * manual's tag semantics already match the recorded polarity —
 * `oil_level_ok` is true when the level is fine even though the sensor on
 * this unit is wired in reverse. A role
 * therefore carries `invert: false` and detection reads every boolean exactly
 * as it was published; {@link resolveRoles} proves it for the whole map.
 */

import type { Sample, Signal } from "@fdp/contracts";

/** The analog roles, in register order, plus the synthetic ambient temperature. */
export const ANALOG_ROLES = [
  "tp2",
  "tp3",
  "h1",
  "dv_pressure",
  "reservoirs",
  "oil_temperature",
  "motor_current",
  "ambient_temperature",
] as const;

/** The digital roles, in register order. */
export const DIGITAL_ROLES = [
  "comp",
  "dv_electric",
  "towers",
  "mpg",
  "lps",
  "pressure_switch",
  "oil_level",
  "caudal_impulses",
] as const;

export type AnalogRole = (typeof ANALOG_ROLES)[number];
export type DigitalRole = (typeof DIGITAL_ROLES)[number];

/** Every signal detection knows about. */
export type SignalRole = AnalogRole | DigitalRole;

/** Roles in register order: the order observations and evidence are emitted in. */
export const SIGNAL_ROLES: readonly SignalRole[] = [
  "tp2",
  "tp3",
  "h1",
  "dv_pressure",
  "reservoirs",
  "oil_temperature",
  "motor_current",
  "comp",
  "dv_electric",
  "towers",
  "mpg",
  "lps",
  "pressure_switch",
  "oil_level",
  "caudal_impulses",
  "ambient_temperature",
];

/** The role of the ambient temperature, the one signal with no source column. */
export const AMBIENT_ROLE = "ambient_temperature";

/**
 * The recording's column behind each role.
 *
 * `DV_eletric` is the dataset's own misspelling and is kept verbatim, as the
 * register map does.
 */
export const ROLE_COLUMNS: Readonly<Record<Exclude<SignalRole, typeof AMBIENT_ROLE>, string>> = {
  tp2: "TP2",
  tp3: "TP3",
  h1: "H1",
  dv_pressure: "DV_pressure",
  reservoirs: "Reservoirs",
  oil_temperature: "Oil_temperature",
  motor_current: "Motor_current",
  comp: "COMP",
  dv_electric: "DV_eletric",
  towers: "Towers",
  mpg: "MPG",
  lps: "LPS",
  pressure_switch: "Pressure_switch",
  oil_level: "Oil_level",
  caudal_impulses: "Caudal_impulses",
};

/** What detection knows about one signal once the register map is resolved. */
export interface SignalRoleBinding {
  readonly role: SignalRole;
  /** The register map's tag id; every message detection emits uses it. */
  readonly signal_id: string;
  /** The register map's human name, for the observation labels. */
  readonly label: string;
  readonly unit: string;
  /** `pressure`, `temperature`, `current` for analogs; `switch`, `command`, `status` for digitals. */
  readonly kind: string;
  readonly analog: boolean;
  /**
   * Always false: the register map applies the polarity, detection never does.
   */
  readonly invert: boolean;
}

/** Every role, resolved. */
export type SignalRoles = Readonly<Record<SignalRole, SignalRoleBinding>>;

/**
 * Bind every role to a signal of the register map.
 *
 * Throws with the missing column named: the backend cannot detect anything
 * without its inputs and says so at startup rather than producing empty
 * observations later.
 */
export function resolveRoles(signals: readonly Signal[]): SignalRoles {
  const byColumn = new Map<string, Signal>();
  for (const signal of signals) {
    if (signal.metropt_column !== null && signal.metropt_column !== "") {
      byColumn.set(signal.metropt_column, signal);
    }
  }

  const bindings: Partial<Record<SignalRole, SignalRoleBinding>> = {};
  for (const [role, column] of Object.entries(ROLE_COLUMNS) as [
    Exclude<SignalRole, typeof AMBIENT_ROLE>,
    string,
  ][]) {
    const signal = byColumn.get(column);
    if (signal === undefined) {
      throw new Error(
        `resolveRoles: no signal of the register map carries the MetroPT-3 column "${column}" ` +
          `(role ${role}); detection cannot start without it`,
      );
    }
    bindings[role] = bind(role, signal);
  }
  bindings[AMBIENT_ROLE] = bind(AMBIENT_ROLE, ambientSignal(signals));

  const roles = bindings as Record<SignalRole, SignalRoleBinding>;
  assertGroups(roles);
  return roles;
}

/** The one `group: "extra"` signal the simulator adds. */
function ambientSignal(signals: readonly Signal[]): Signal {
  const extras = signals.filter((signal) => signal.group === "extra");
  const ambient = extras[0];
  if (ambient === undefined || extras.length !== 1) {
    throw new Error(
      `resolveRoles: the register map must carry exactly one synthetic "extra" signal for the ` +
        `role ${AMBIENT_ROLE}, found ${String(extras.length)}`,
    );
  }
  return ambient;
}

function bind(role: SignalRole, signal: Signal): SignalRoleBinding {
  return {
    role,
    signal_id: signal.tag,
    label: signal.name,
    unit: signal.unit,
    kind: signal.kind,
    analog: signal.group !== "digital",
    invert: false,
  };
}

/** The register map must agree with this module about which roles are analog. */
function assertGroups(roles: SignalRoles): void {
  for (const role of ANALOG_ROLES) {
    if (!roles[role].analog) {
      throw new Error(
        `resolveRoles: the register map declares ${roles[role].signal_id} (role ${role}) digital, ` +
          "but detection reads it as an analog value",
      );
    }
  }
  for (const role of DIGITAL_ROLES) {
    if (roles[role].analog) {
      throw new Error(
        `resolveRoles: the register map declares ${roles[role].signal_id} (role ${role}) analog, ` +
          "but detection reads it as a boolean",
      );
    }
  }
}

/**
 * The analog value of a role, or undefined when the sample does not carry it.
 *
 * A sample whose `flags.missing` is set keeps the previous value of the
 * affected tags (telemetry-samples schema), so an absent or wrongly typed
 * value is a hole the caller fills from what it saw last, never a zero.
 */
export function analogValue(sample: Sample, binding: SignalRoleBinding): number | undefined {
  const value = sample.values[binding.signal_id];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The boolean value of a digital role, or undefined when the sample lacks it. */
export function digitalValue(sample: Sample, binding: SignalRoleBinding): boolean | undefined {
  const value = sample.values[binding.signal_id];
  return typeof value === "boolean" ? value : undefined;
}
