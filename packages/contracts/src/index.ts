// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// The public API of `@fdp/contracts`. Nothing here touches the file system, so the frontend can
// import the types and the topic builders; the fixture helpers live behind `@fdp/contracts/testing`
// instead.

export { SCHEMA_IDS, SCHEMA_NAMES, schemas } from "./generated/schemas.ts";
export type { SchemaName } from "./generated/schemas.ts";

// Every message type. `export *` picks up a new schema without a change here.
export * from "./generated/types.ts";

export { AJV_OPTIONS, isSchemaName, validators } from "./generated/validators.ts";

export { SchemaValidationError, assertValid, isValid, validate, validateMqtt } from "./validate.ts";
export type { SchemaType, ValidationIssue, ValidationResult } from "./validate.ts";

export {
  ACL,
  DEFAULT_UNIT_ID,
  ROOTS,
  TOPIC_META,
  schemaForTopic,
  subscriptionsFor,
  topics,
} from "./generated/topics.ts";
export type { AclCredential, TopicKey } from "./generated/topics.ts";

export {
  ALARMS,
  REGISTER_MAP,
  SIGNALS,
  alarmByCode,
  alarmCodes,
  decodeAnalog,
  encodeAnalog,
  signalById,
  slotAddress,
} from "./generated/register-map.ts";
export type { Alarm, Signal } from "./generated/register-map.ts";

export { EMBEDDING } from "./generated/embedding.ts";

export { ISO_MS_PATTERN, parseIsoMs, simMinutesBetween, toIsoMs } from "./time.ts";

/** The version of this package; `test/schemas.test.ts` keeps it equal to `package.json`. */
export const CONTRACTS_VERSION = "1.0.0";
