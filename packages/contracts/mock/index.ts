// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Entry point of `@fdp/contracts/mock`: the local stand-ins for the two APIs this project calls out
// to — TypeSafe System One and the Anthropic Messages API. Tests and the Compose CI stack talk to
// these instead of the network, so no test needs a key and no test makes a live call.

export {
  startMockTypeSafe,
  answerPolicyFromEnv,
  systemOneResponseIssue,
  ACCEPTED_MODELS,
  MOCK_MODEL,
  MOCK_MODEL_LIST,
} from "./typesafe-mock.ts";
export type { FailStatus, MockTypeSafe, MockTypeSafeOptions } from "./typesafe-mock.ts";

export { ANSWER_POLICY_NAMES, isAnswerPolicyName } from "./answers.ts";
export type {
  Answer,
  AnswerPolicy,
  AnswerPolicyName,
  ChoiceAnswer,
  ChoiceQuestion,
  Entry,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResponse,
} from "./answers.ts";

export { startMockAnthropic } from "./anthropic-mock.ts";
export type {
  AnthropicFailStatus,
  AnthropicMessage,
  AnthropicMessagesRequest,
  JsonSchemaOutputFormat,
  MessagePolicy,
  MockAnthropic,
  MockAnthropicOptions,
  MockStopReason,
  RefusalStopDetails,
  ScriptedMessage,
  TextBlock,
} from "./anthropic-mock.ts";

export { REDACTED } from "./http.ts";
export type { LogLine, MockServer, RecordedRequest } from "./http.ts";
