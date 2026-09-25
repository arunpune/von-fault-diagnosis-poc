// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/contracts"
)

// unitID is the only machine of this proof of concept.
const unitID = "cau-7"

// analogTags and digitalTags are the signal registry of the manual, in
// register order (services/modbus/internal/regmap). A hand-built batch keys
// its readings by these ids, the way the gateway does.
var (
	analogTags = []string{
		"discharge_pressure",
		"line_pressure",
		"separator_discharge_pressure",
		"dryer_purge_pressure",
		"reservoir_pressure",
		"oil_temperature",
		"motor_current",
		"ambient_temperature",
	}
	digitalTags = []string{
		"intake_closed",
		"load_valve",
		"dryer_tower",
		"regulator_contact",
		"low_pressure_switch",
		"purge_switch",
		"oil_level_ok",
		"flow_pulse",
	}
)

// baseSimTS is the first data instant of the recording; the hand-built
// messages step forward from it so nothing in this file reads a clock.
var baseSimTS = contracts.FromUnixMilli(1580515200000) // 2020-02-01T00:00:00.000Z

// TestHandBuiltTelemetryBatchValidates builds the largest batch the schema
// allows, with both kinds of tag and with alarms, and measures it against the
// published schema exactly as it would go on the wire.
func TestHandBuiltTelemetryBatchValidates(t *testing.T) {
	t.Parallel()

	const batchSize = 25

	batch := contracts.TelemetrySamples{
		Envelope: contracts.NewEnvelope(contracts.SchemaTelemetrySamples, unitID),
		Samples:  make([]contracts.Sample, 0, batchSize),
		Poll:     &contracts.PollStats{PollSeq: 412, ReadMs: 9},
	}
	for i := range batchSize {
		values := contracts.Values{}
		for j, tag := range analogTags {
			values[tag] = contracts.NumberValue(float64(j) + float64(i)/100)
		}
		for j, tag := range digitalTags {
			values[tag] = contracts.BoolValue((i+j)%2 == 0)
		}

		alarms := []string{}
		if i == 7 {
			alarms = []string{"W101", "X201"}
		}
		batch.Samples = append(batch.Samples, contracts.Sample{
			Seq:    uint32(i + 1),
			SimTS:  contracts.FromUnixMilli(baseSimTS.UnixMilli() + int64(i)*10_000),
			Flags:  contracts.SampleFlags{Discontinuity: i == 0, Missing: i == 3},
			Values: values,
			Alarms: alarms,
		})
	}

	validator := newValidator(t)
	require.NoError(t, validator.ValidateValue("telemetry-samples", batch))

	encoded, err := json.Marshal(batch)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"alarms":[]`, "an empty alarm list is written as [], never as null")

	var decoded contracts.TelemetrySamples
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	require.Equal(t, batch, decoded)
}

// TestHandBuiltControlCommandsValidateAndParse walks every command of the
// enum: the message validates and ParseArgs returns the argument struct the
// schema's oneOf branch describes.
func TestHandBuiltControlCommandsValidateAndParse(t *testing.T) {
	t.Parallel()

	presetID := "f3_air_leak_jun05"
	jumpTS := contracts.FromUnixMilli(1591351200000) // 2020-06-05T10:00:00.000Z
	magnitude := 1.5
	duration := 240

	cases := []struct {
		name string
		cmd  string
		args any
		want any
	}{
		{"play", contracts.CmdPlay, contracts.NoArgs{}, contracts.NoArgs{}},
		{"pause", contracts.CmdPause, contracts.NoArgs{}, contracts.NoArgs{}},
		{"clear_injections", contracts.CmdClearInjections, contracts.NoArgs{}, contracts.NoArgs{}},
		{"reset", contracts.CmdReset, contracts.NoArgs{}, contracts.NoArgs{}},
		{
			name: "set_speed",
			cmd:  contracts.CmdSetSpeed,
			args: contracts.SetSpeedArgs{Speed: 600},
			want: contracts.SetSpeedArgs{Speed: 600},
		},
		{
			name: "jump to a preset",
			cmd:  contracts.CmdJump,
			args: contracts.JumpArgs{PresetID: &presetID},
			want: contracts.JumpArgs{PresetID: &presetID},
		},
		{
			name: "jump to an instant",
			cmd:  contracts.CmdJump,
			args: contracts.JumpArgs{SimTS: &jumpTS},
			want: contracts.JumpArgs{SimTS: &jumpTS},
		},
		{
			name: "inject with defaults",
			cmd:  contracts.CmdInject,
			args: contracts.InjectArgs{InjectionID: "downstream_air_leak"},
			want: contracts.InjectArgs{InjectionID: "downstream_air_leak"},
		},
		{
			name: "inject with overrides",
			cmd:  contracts.CmdInject,
			args: contracts.InjectArgs{
				InjectionID: "downstream_air_leak",
				Params:      &contracts.InjectParams{Magnitude: &magnitude, DurationSimMin: &duration},
			},
			want: contracts.InjectArgs{
				InjectionID: "downstream_air_leak",
				Params:      &contracts.InjectParams{Magnitude: &magnitude, DurationSimMin: &duration},
			},
		},
	}

	validator := newValidator(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			args, err := json.Marshal(tc.args)
			require.NoError(t, err)

			cmd := contracts.ControlCmd{
				Envelope: contracts.NewEnvelope(contracts.SchemaControlCmd, unitID),
				CmdID:    "6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f8091a2",
				Cmd:      tc.cmd,
				Args:     args,
			}
			require.NoError(t, validator.ValidateValue("control-cmd", cmd))

			parsed, err := cmd.ParseArgs()
			require.NoError(t, err)
			require.Equal(t, tc.want, parsed)
		})
	}
}

// TestParseArgsRefusesWhatTheSchemaRefuses keeps the Go reader as strict as
// the schema's closed argument objects and its jump oneOf.
func TestParseArgsRefusesWhatTheSchemaRefuses(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		cmd  string
		args string
	}{
		{"an unknown command", "fast_forward", `{}`},
		{"an unknown member", contracts.CmdSetSpeed, `{"speed":600,"units":"minutes"}`},
		{"a jump naming both alternatives", contracts.CmdJump, `{"preset_id":"baseline_feb","sim_ts":"2020-02-01T00:00:00.000Z"}`},
		{"a jump naming neither", contracts.CmdJump, `{}`},
		{"an instant outside the contract format", contracts.CmdJump, `{"sim_ts":"2020-02-01T00:00:00Z"}`},
		{"arguments that are not an object", contracts.CmdPlay, `[]`},
		{"no arguments at all", contracts.CmdPlay, ``},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cmd := contracts.ControlCmd{
				Envelope: contracts.NewEnvelope(contracts.SchemaControlCmd, unitID),
				CmdID:    "6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f8091a2",
				Cmd:      tc.cmd,
				Args:     json.RawMessage(tc.args),
			}
			_, err := cmd.ParseArgs()
			require.Error(t, err)
		})
	}
}

// TestControlCmdWithoutArgsWritesAnEmptyObject holds the encoder to the
// schema: args is required, so a command that was built without them carries
// {} rather than null.
func TestControlCmdWithoutArgsWritesAnEmptyObject(t *testing.T) {
	t.Parallel()

	cmd := contracts.ControlCmd{
		Envelope: contracts.NewEnvelope(contracts.SchemaControlCmd, unitID),
		CmdID:    "6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f8091a2",
		Cmd:      contracts.CmdPause,
	}

	encoded, err := json.Marshal(cmd)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"args":{}`)
	require.NoError(t, newValidator(t).Validate("control-cmd", encoded))
}

// statusSim is the snapshot the acknowledgement and the status test share.
func statusSim() contracts.StatusSim {
	return contracts.StatusSim{
		Envelope: contracts.NewEnvelope(contracts.SchemaStatusSim, unitID),
		SimTS:    contracts.FromUnixMilli(1591352900000), // 2020-06-05T10:28:20.000Z
		State:    "playing",
		Speed:    600,
		HeadSeq:  128634,
		Dataset: contracts.DatasetInfo{
			FirstTS: datasetFirstTS,
			LastTS:  datasetLastTS,
			Rows:    datasetRows,
			SHA256:  datasetSHA256,
			Source:  "MetroPT3(AirCompressor).csv",
		},
		Loop:    false,
		UptimeS: 3724,
	}
}

// TestHandBuiltStatusMessagesValidate covers the two retained status messages
// and, with them, the two required members the schemas allow to be null.
func TestHandBuiltStatusMessagesValidate(t *testing.T) {
	t.Parallel()

	validator := newValidator(t)

	t.Run("status-sim", func(t *testing.T) {
		t.Parallel()

		require.NoError(t, validator.ValidateValue("status-sim", statusSim()))
	})

	t.Run("status-gateway", func(t *testing.T) {
		t.Parallel()

		status := contracts.StatusGateway{
			Envelope:        contracts.NewEnvelope(contracts.SchemaStatusGateway, unitID),
			LastSeq:         128634,
			DroppedTotal:    0,
			PollsTotal:      41219,
			PollErrorsTotal: 2,
			PollIntervalMs:  250,
			SamplesPerS:     4.98,
			Modbus: contracts.ModbusEndpoint{
				Host:      "modbus-sim",
				Port:      5020,
				Connected: true,
				MapMajor:  ptr(1),
				MapMinor:  ptr(0),
			},
		}

		encoded, err := json.Marshal(status)
		require.NoError(t, err)
		require.Contains(t, string(encoded), `"last_error":null`,
			"a required nullable member is written as null, never dropped")
		require.NoError(t, validator.Validate("status-gateway", encoded))
	})

	t.Run("control-ack", func(t *testing.T) {
		t.Parallel()

		ack := contracts.ControlAck{
			Envelope:   contracts.NewEnvelope(contracts.SchemaControlAck, unitID),
			CmdID:      "6f7a8b9c-0d1e-4f2a-9b4c-5d6e7f8091a2",
			Cmd:        contracts.CmdInject,
			OK:         true,
			Status:     statusSim(),
			InstanceID: ptr("inj-4f21-3"),
		}

		encoded, err := json.Marshal(ack)
		require.NoError(t, err)
		require.Contains(t, string(encoded), `"error":null`,
			"a required nullable member is written as null, never dropped")
		require.NoError(t, validator.Validate("control-ack", encoded))

		refused := ack
		refused.OK = false
		refused.InstanceID = nil
		refused.Error = &contracts.AckError{Code: "unknown_injection", Message: "No injection is called that."}

		encoded, err = json.Marshal(refused)
		require.NoError(t, err)
		require.NotContains(t, string(encoded), "instance_id", "an absent optional member is dropped, not nulled")
		require.NoError(t, validator.Validate("control-ack", encoded))
	})
}

// TestHandBuiltGroundTruthEventsValidate covers the three ground-truth
// messages the simulator publishes beside the catalog.
func TestHandBuiltGroundTruthEventsValidate(t *testing.T) {
	t.Parallel()

	validator := newValidator(t)
	startedAt := contracts.FromUnixMilli(1580515200000)
	endsAt := contracts.FromUnixMilli(1580551200000)
	params := contracts.InstanceParams{Magnitude: 1.0, DurationSimMin: 600}

	require.NoError(t, validator.ValidateValue("gt-injection", contracts.GtInjection{
		Envelope:    contracts.NewEnvelope(contracts.SchemaGtInjection, unitID),
		SimTS:       startedAt,
		Event:       "start",
		InstanceID:  "inj-7f3a-1",
		InjectionID: "oil_cooler_fouling",
		FaultID:     "oil_cooler_fouled",
		Params:      params,
		EndsSimTS:   endsAt,
	}))

	require.NoError(t, validator.ValidateValue("gt-injection-active", contracts.GtInjectionActive{
		Envelope: contracts.NewEnvelope(contracts.SchemaGtInjectionActive, unitID),
		SimTS:    startedAt,
		Active: []contracts.ActiveInstance{{
			InstanceID:   "inj-7f3a-1",
			InjectionID:  "oil_cooler_fouling",
			FaultID:      "oil_cooler_fouled",
			StartedSimTS: startedAt,
			EndsSimTS:    endsAt,
			Params:       params,
		}},
	}))

	cleared := contracts.GtInjectionActive{
		Envelope: contracts.NewEnvelope(contracts.SchemaGtInjectionActive, unitID),
		SimTS:    endsAt,
		Active:   []contracts.ActiveInstance{},
	}
	encoded, err := json.Marshal(cleared)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"active":[]`, "an empty overlay is written as [], never as null")
	require.NoError(t, validator.Validate("gt-injection-active", encoded))

	require.NoError(t, validator.ValidateValue("gt-marker", contracts.GtMarker{
		Envelope:  contracts.NewEnvelope(contracts.SchemaGtMarker, unitID),
		Kind:      "jump",
		PresetID:  ptr("f3_air_leak_jun05"),
		SimTSFrom: startedAt,
		SimTSTo:   endsAt,
	}))
}

// The replay source the simulator serves (docs/dataset.md): the whole
// MetroPT-3 recording, 331 gaps over a minute.
var (
	datasetFirstTS = contracts.FromUnixMilli(1580515200000) // 2020-02-01T00:00:00.000Z
	datasetLastTS  = contracts.FromUnixMilli(1598932790000) // 2020-09-01T03:59:50.000Z
)

const (
	datasetRows   = 1516948
	datasetGaps   = 331
	datasetSHA256 = "db30ccb4ea402e3c8bf2c99db06e288d4f2a772f6928f9dbe26a920d69793e24"
)

// groundTruthFiles are the documents the catalog forwards, in the name order
// the source digest is taken over (gt-catalog.schema.json, source_sha256).
var groundTruthFiles = []string{"injections.json", "metropt3-failures.json", "presets.json"}

// TestGtCatalogBuiltFromTheRealGroundTruthFiles is the acceptance case of the
// ground-truth side: the three committed documents decode into the Go structs,
// go into a catalog message unchanged, and that message validates.
func TestGtCatalogBuiltFromTheRealGroundTruthFiles(t *testing.T) {
	t.Parallel()

	var presets contracts.GtPresets
	require.NoError(t, json.Unmarshal(groundTruthFile(t, "presets.json"), &presets))
	require.Equal(t, contracts.SchemaGtPresets, presets.Schema)
	require.NotEmpty(t, presets.Presets)

	var failures contracts.GtFailureTable
	require.NoError(t, json.Unmarshal(groundTruthFile(t, "metropt3-failures.json"), &failures))
	require.Equal(t, contracts.SchemaGtFailureTable, failures.Schema)
	require.Equal(t, "utc-assumed", failures.Clock)
	require.NotEmpty(t, failures.Failures)

	var injections contracts.GtInjections
	require.NoError(t, json.Unmarshal(groundTruthFile(t, "injections.json"), &injections))
	require.Equal(t, contracts.SchemaGtInjections, injections.Schema)
	require.NotEmpty(t, injections.Injections)

	menu := make([]contracts.GtCatalogInjection, 0, len(injections.Injections))
	for _, def := range injections.Injections {
		menu = append(menu, def.Summary())
	}

	digest := sha256.New()
	for _, name := range groundTruthFiles {
		digest.Write(groundTruthFile(t, name))
	}

	catalog := contracts.GtCatalog{
		Envelope: contracts.NewEnvelope(contracts.SchemaGtCatalog, unitID),
		Dataset: contracts.GtCatalogDataset{
			FirstTS: datasetFirstTS,
			LastTS:  datasetLastTS,
			Rows:    datasetRows,
			Gaps:    datasetGaps,
		},
		Presets:      presets,
		Injections:   menu,
		Failures:     failures,
		SourceSHA256: hex.EncodeToString(digest.Sum(nil)),
	}

	validator := newValidator(t)
	require.NoError(t, validator.ValidateValue("gt-catalog", catalog))

	// The two forwarded documents travel verbatim: what comes out of the
	// catalog has to be byte-for-byte what the standalone documents are.
	encodedPresets, err := json.Marshal(catalog.Presets)
	require.NoError(t, err)
	requireJSONEqual(t, groundTruthFile(t, "presets.json"), encodedPresets)

	encodedFailures, err := json.Marshal(catalog.Failures)
	require.NoError(t, err)
	requireJSONEqual(t, groundTruthFile(t, "metropt3-failures.json"), encodedFailures)
}

// TestGtInjectionDefinitionsParseTheirTransforms reads the committed injection
// definitions and decodes every transform into the parameter struct its op
// declares, which is what the simulator's injector does at start-up.
func TestGtInjectionDefinitionsParseTheirTransforms(t *testing.T) {
	t.Parallel()

	var injections contracts.GtInjections
	require.NoError(t, json.Unmarshal(groundTruthFile(t, "injections.json"), &injections))

	seen := map[string]int{}
	for _, def := range injections.Injections {
		require.NotEmpty(t, def.Transforms, "%s declares no transform", def.InjectionID)
		for _, transform := range def.Transforms {
			params, err := transform.ParseParams()
			require.NoError(t, err, "%s: the %s transform of %q", def.InjectionID, transform.Op, transform.Tag)
			require.NotNil(t, params)
			seen[transform.Op]++
		}
	}
	require.NotEmpty(t, seen)
}

// TestTransformParamsCoverEveryPrimitive walks the seven primitives of the
// schema through the same fixture the TypeScript harness uses, so a renamed
// parameter is caught here rather than in the simulator.
func TestTransformParamsCoverEveryPrimitive(t *testing.T) {
	t.Parallel()

	var def contracts.GtInjectionDef
	require.NoError(t, json.Unmarshal(
		readCompact(t, fixturesDirPath+"/gt-injection-def/valid-every-primitive.json"), &def))

	want := map[string]any{
		contracts.OpOffset:    contracts.OffsetParams{},
		contracts.OpScale:     contracts.ScaleParams{},
		contracts.OpRamp:      contracts.RampParams{},
		contracts.OpNoise:     contracts.NoiseParams{},
		contracts.OpStuck:     contracts.StuckParams{},
		contracts.OpDutyShift: contracts.DutyShiftParams{},
		contracts.OpDropout:   contracts.DropoutParams{},
	}

	seen := map[string]bool{}
	for _, transform := range def.Transforms {
		params, err := transform.ParseParams()
		require.NoError(t, err)
		require.IsType(t, want[transform.Op], params, "the %s transform decoded into the wrong struct", transform.Op)
		seen[transform.Op] = true
	}
	for op := range want {
		require.True(t, seen[op], "the fixture carries no %s transform", op)
	}

	unknown := contracts.Transform{Tag: "oil_temperature", When: "any", Op: "teleport"}
	_, err := unknown.ParseParams()
	require.Error(t, err)
}

// TestPresetsCarryTheirNullFailureID is the third shape of a required nullable
// member: a preset that shows no scored failure writes null.
func TestPresetsCarryTheirNullFailureID(t *testing.T) {
	t.Parallel()

	preset := contracts.GtPresetDef{
		PresetID:  "baseline_feb",
		Label:     "Normal operation – 1 Feb 2020",
		Kind:      "baseline",
		SimTS:     datasetFirstTS,
		LeadInMin: 0,
		Note:      "Start of the recording; nothing to find here.",
	}

	encoded, err := json.Marshal(preset)
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"failure_id":null`)
	require.NoError(t, newValidator(t).Validate("gt-preset-def", encoded))
}
