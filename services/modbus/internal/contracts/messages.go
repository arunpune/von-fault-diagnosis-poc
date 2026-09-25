// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// The $id of every schema this package models; the value goes into the
// envelope's schema field so a consumer can reject an unknown major
// (packages/contracts/VERSIONING.md).
const (
	SchemaTelemetrySamples  = "urn:fdp:schema:telemetry-samples:v1"
	SchemaControlCmd        = "urn:fdp:schema:control-cmd:v1"
	SchemaControlAck        = "urn:fdp:schema:control-ack:v1"
	SchemaStatusSim         = "urn:fdp:schema:status-sim:v1"
	SchemaStatusGateway     = "urn:fdp:schema:status-gateway:v1"
	SchemaGtPresets         = "urn:fdp:schema:gt-presets:v1"
	SchemaGtInjections      = "urn:fdp:schema:gt-injections:v1"
	SchemaGtFailureTable    = "urn:fdp:schema:gt-failure-table:v1"
	SchemaGtCatalog         = "urn:fdp:schema:gt-catalog:v1"
	SchemaGtInjection       = "urn:fdp:schema:gt-injection:v1"
	SchemaGtInjectionActive = "urn:fdp:schema:gt-injection-active:v1"
	SchemaGtMarker          = "urn:fdp:schema:gt-marker:v1"
)

// The commands the simulator answers (control-cmd.schema.json, command).
const (
	CmdPlay            = "play"
	CmdPause           = "pause"
	CmdSetSpeed        = "set_speed"
	CmdJump            = "jump"
	CmdInject          = "inject"
	CmdClearInjections = "clear_injections"
	CmdReset           = "reset"
)

// The transform primitives of an injection definition
// (gt-injection-def.schema.json, transform).
const (
	OpOffset    = "offset"
	OpScale     = "scale"
	OpRamp      = "ramp"
	OpNoise     = "noise"
	OpStuck     = "stuck"
	OpDutyShift = "duty_shift"
	OpDropout   = "dropout"
)

// Envelope is the three fields every MQTT message carries
// (common.schema.json, envelope). Messages embed it, so the fields appear at
// the top level of the encoded object.
type Envelope struct {
	// Schema is the $id of the message's schema.
	Schema string `json:"schema"`
	// UnitID is the machine the message is about; the only unit of this
	// proof of concept is cau-7.
	UnitID string `json:"unit_id"`
	// WallTS is the wall-clock instant the message was produced at, never
	// simulated time.
	WallTS Time `json:"wall_ts"`
}

// NewEnvelope stamps an envelope for the given schema and unit at the current
// wall-clock instant.
func NewEnvelope(schema, unitID string) Envelope {
	return Envelope{Schema: schema, UnitID: unitID, WallTS: Now()}
}

// SampleFlags are the two slot flags of the register model, forwarded
// unchanged by the gateway.
type SampleFlags struct {
	// Discontinuity marks a jump in data time before this sample.
	Discontinuity bool `json:"discontinuity"`
	// Missing marks a row at least one source column of which could not be
	// parsed; the affected tags keep their previous reading.
	Missing bool `json:"missing"`
}

// Sample is one decoded slot of the simulator's ring buffer.
type Sample struct {
	// Seq is the sequence number the simulator wrote with the slot.
	Seq uint32 `json:"seq"`
	// SimTS is the data time of the replayed row.
	SimTS Time `json:"sim_ts"`
	// Flags are the slot flags.
	Flags SampleFlags `json:"flags"`
	// Values is one reading per tag of the signal registry.
	Values Values `json:"values"`
	// Alarms are the controller alarm codes active on this row, in
	// ascending bit order. Required, so an empty list is written as [].
	Alarms []string `json:"alarms"`
}

// PollStats is what the gateway measured while reading one batch; diagnostics
// only.
type PollStats struct {
	// PollSeq counts the poll cycles the gateway has completed.
	PollSeq int `json:"poll_seq"`
	// ReadMs is how long the register reads of this batch took.
	ReadMs int `json:"read_ms"`
}

// TelemetrySamples is one poll batch of 1 to 25 samples, published by the
// gateway on plant/{unit_id}/telemetry/samples.
type TelemetrySamples struct {
	Envelope
	// Samples are the slots of the batch, ordered by ascending Seq.
	Samples []Sample `json:"samples"`
	// Poll is optional diagnostic detail about the read.
	Poll *PollStats `json:"poll,omitempty"`
}

// ControlCmd is a replay command for the simulator, published by the backend's
// ops client on plant/{unit_id}/control/cmd.
type ControlCmd struct {
	Envelope
	// CmdID identifies this command and makes a repeat idempotent.
	CmdID string `json:"cmd_id"`
	// Cmd is one of the Cmd* constants.
	Cmd string `json:"cmd"`
	// Args are the arguments the command declares; ParseArgs decodes them
	// into the matching typed struct.
	Args json.RawMessage `json:"args"`
}

// MarshalJSON writes the command, substituting an empty object for arguments
// that were never set: args is required and the commands that take none carry
// {}, never null.
func (c ControlCmd) MarshalJSON() ([]byte, error) {
	type plain ControlCmd
	out := plain(c)
	if len(bytes.TrimSpace(out.Args)) == 0 {
		out.Args = json.RawMessage("{}")
	}
	return json.Marshal(out)
}

// NoArgs is the empty argument object of play, pause, clear_injections and
// reset.
type NoArgs struct{}

// SetSpeedArgs are the arguments of set_speed.
type SetSpeedArgs struct {
	// Speed is simulated seconds per wall-clock second, 1 to 3600.
	Speed int `json:"speed"`
}

// JumpArgs are the arguments of jump: exactly one of a preset or a data time.
type JumpArgs struct {
	// PresetID names a preset of the ground-truth catalog.
	PresetID *string `json:"preset_id,omitempty"`
	// SimTS is a data time inside the replayed dataset.
	SimTS *Time `json:"sim_ts,omitempty"`
}

// InjectParams are the overrides an inject command may carry; an omitted
// parameter falls back to what the injection declares.
type InjectParams struct {
	// Magnitude is the strength of the injection, greater than zero.
	Magnitude *float64 `json:"magnitude,omitempty"`
	// DurationSimMin is the length in simulated minutes, 1 to 14400.
	DurationSimMin *int `json:"duration_sim_min,omitempty"`
}

// InjectArgs are the arguments of inject.
type InjectArgs struct {
	// InjectionID names an injection the simulator offers.
	InjectionID string `json:"injection_id"`
	// Params overrides the injection's declared defaults.
	Params *InjectParams `json:"params,omitempty"`
}

// ParseArgs decodes Args into the argument struct the command declares and
// returns it: NoArgs, SetSpeedArgs, JumpArgs or InjectArgs. Unknown members
// are rejected, because every argument object of the schema is closed, and a
// jump that names both a preset and an instant is rejected as well.
func (c ControlCmd) ParseArgs() (any, error) {
	what := "the arguments of " + c.Cmd
	switch c.Cmd {
	case CmdPlay, CmdPause, CmdClearInjections, CmdReset:
		var args NoArgs
		if err := decodeClosed(c.Args, &args, what); err != nil {
			return nil, err
		}
		return args, nil
	case CmdSetSpeed:
		var args SetSpeedArgs
		if err := decodeClosed(c.Args, &args, what); err != nil {
			return nil, err
		}
		return args, nil
	case CmdJump:
		var args JumpArgs
		if err := decodeClosed(c.Args, &args, what); err != nil {
			return nil, err
		}
		if (args.PresetID == nil) == (args.SimTS == nil) {
			return nil, fmt.Errorf("contracts: a jump names exactly one of preset_id and sim_ts")
		}
		return args, nil
	case CmdInject:
		var args InjectArgs
		if err := decodeClosed(c.Args, &args, what); err != nil {
			return nil, err
		}
		return args, nil
	default:
		return nil, fmt.Errorf("contracts: unknown command %q", c.Cmd)
	}
}

// AckError is why the simulator refused a command.
type AckError struct {
	// Code is the machine-readable reason.
	Code string `json:"code"`
	// Message is one English sentence for the operator.
	Message string `json:"message"`
}

// ControlAck is the simulator's answer to one command, published on
// plant/{unit_id}/control/ack.
type ControlAck struct {
	Envelope
	// CmdID is the command this answers.
	CmdID string `json:"cmd_id"`
	// Cmd is the command that was received, echoed unchanged.
	Cmd string `json:"cmd"`
	// OK is true when the command was applied.
	OK bool `json:"ok"`
	// Error is null when OK, the refusal otherwise. Required and nullable,
	// so it is written as null rather than dropped.
	Error *AckError `json:"error"`
	// Status is the simulator's status after the command.
	Status StatusSim `json:"status"`
	// InstanceID is the injection instance a successful inject started, the id
	// its ground-truth events carry; absent for every other command.
	InstanceID *string `json:"instance_id,omitempty"`
}

// DatasetInfo is the replay source the simulator indexed.
type DatasetInfo struct {
	// FirstTS is the data time of the first row.
	FirstTS Time `json:"first_ts"`
	// LastTS is the data time of the last row.
	LastTS Time `json:"last_ts"`
	// Rows is how many rows were indexed.
	Rows int `json:"rows"`
	// SHA256 is the digest of the replayed file, when one was computed.
	SHA256 string `json:"sha256,omitempty"`
	// Source names where the rows come from, such as the opened file.
	Source string `json:"source,omitempty"`
}

// StatusSim is the retained replay status on plant/{unit_id}/status/sim. It
// says where the cursor sits and how fast it moves and nothing else: anonymous
// browser clients read this topic (ground-truth isolation).
type StatusSim struct {
	Envelope
	// SimTS is the data time the cursor sits on.
	SimTS Time `json:"sim_ts"`
	// State is stopped, playing or paused.
	State string `json:"state"`
	// Speed is simulated seconds per wall-clock second.
	Speed int `json:"speed"`
	// HeadSeq is the sequence number of the newest sample in the ring.
	HeadSeq uint32 `json:"head_seq"`
	// Dataset is the replay source.
	Dataset DatasetInfo `json:"dataset"`
	// Loop is true when the cursor wraps at the end of the data.
	Loop bool `json:"loop"`
	// UptimeS is whole seconds since the simulator started.
	UptimeS int `json:"uptime_s"`
}

// ModbusEndpoint is the Modbus side of the gateway's status.
type ModbusEndpoint struct {
	// Host is the host name or address of the simulator.
	Host string `json:"host"`
	// Port is its TCP port.
	Port int `json:"port"`
	// Connected is true while the client holds an open connection.
	Connected bool `json:"connected"`
	// MapMajor is the major version of the register map the simulator
	// reports; absent when the header block has not been read.
	MapMajor *int `json:"map_major,omitempty"`
	// MapMinor is the minor version, on the same terms.
	MapMinor *int `json:"map_minor,omitempty"`
}

// StatusGateway is the retained gateway health message on
// plant/{unit_id}/status/gateway. The counters are monotonic since start.
type StatusGateway struct {
	Envelope
	// LastSeq is the newest sample the gateway published.
	LastSeq uint32 `json:"last_seq"`
	// DroppedTotal counts samples the ring overwrote before they were read.
	DroppedTotal int64 `json:"dropped_total"`
	// PollsTotal counts completed poll cycles.
	PollsTotal int64 `json:"polls_total"`
	// PollErrorsTotal counts poll cycles that ended in a read error.
	PollErrorsTotal int64 `json:"poll_errors_total"`
	// PollIntervalMs is the wait between two cycles once caught up.
	PollIntervalMs int `json:"poll_interval_ms"`
	// SamplesPerS is the publication rate over the last window.
	SamplesPerS float64 `json:"samples_per_s"`
	// Modbus is the endpoint the gateway reads from.
	Modbus ModbusEndpoint `json:"modbus"`
	// LastError is null while the last cycle succeeded. Required and
	// nullable, so it is written as null rather than dropped.
	LastError *string `json:"last_error"`
}

// GtPresetDef is one entry of the simulator's jump menu; it never travels on
// its own, only inside a GtPresets document.
type GtPresetDef struct {
	// PresetID identifies the preset.
	PresetID string `json:"preset_id"`
	// Label is the menu text, shown verbatim.
	Label string `json:"label"`
	// Kind is failure, precursor, diagnostic or baseline.
	Kind string `json:"kind"`
	// SimTS is the instant the preset is named after.
	SimTS Time `json:"sim_ts"`
	// LeadInMin is how many simulated minutes of context precede SimTS.
	LeadInMin int `json:"lead_in_min"`
	// FailureID is the failure of the ground-truth table this preset shows,
	// or null when the preset is not scored.
	FailureID *string `json:"failure_id"`
	// Note says why the preset exists.
	Note string `json:"note"`
}

// GtPresets is the document packages/ground-truth/data/presets.json.
type GtPresets struct {
	// Schema is SchemaGtPresets.
	Schema string `json:"schema"`
	// Presets is the jump menu, in the order the user interface shows it.
	Presets []GtPresetDef `json:"presets"`
}

// InjectionParamDef is one tunable parameter of an injection with its bounds
// (an array of named parameters, not a map).
type InjectionParamDef struct {
	// Name is the parameter's identifier, such as magnitude.
	Name string `json:"name"`
	// Default is the value used when a command names none.
	Default float64 `json:"default"`
	// Min and Max bound what a command may ask for.
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// InjectionEnvelope is the trapezoid an instance follows in simulated time.
type InjectionEnvelope struct {
	// RampInMin is how long the magnitude takes to reach one.
	RampInMin int `json:"ramp_in_min"`
	// RampOutMin is how long it takes to fall back to zero.
	RampOutMin int `json:"ramp_out_min"`
}

// Transform is one overlay on one tag. The three shared fields are named; the
// primitive's own parameters stay as Params, which ParseParams decodes into
// the struct the op declares.
//
// The schema spells a transform as one flat closed object per op, so Params is
// the object's remaining members rather than a nested value; the custom JSON
// methods below flatten and unflatten it.
type Transform struct {
	// Tag is the signal the overlay applies to.
	Tag string
	// When is the machine state guard: any, loaded, not_loaded, unloaded
	// or off.
	When string
	// Op is one of the Op* constants.
	Op string
	// Params is a JSON object holding the op's own parameters.
	Params json.RawMessage
}

// OffsetParams are the parameters of an offset transform.
type OffsetParams struct {
	// Value is added to the analog reading, scaled by the envelope.
	Value float64 `json:"value"`
}

// ScaleParams are the parameters of a scale transform.
type ScaleParams struct {
	// Factor multiplies the analog reading.
	Factor float64 `json:"factor"`
}

// RampParams are the parameters of a ramp transform.
type RampParams struct {
	// RatePerMin is the change per simulated minute since the anchor.
	RatePerMin float64 `json:"rate_per_min"`
	// Cap is the largest absolute deviation the ramp may reach.
	Cap float64 `json:"cap"`
	// Anchor is injection_start, state_entry or guard_entry.
	Anchor string `json:"anchor"`
}

// NoiseParams are the parameters of a noise transform.
type NoiseParams struct {
	// Sigma is the standard deviation of the added zero-mean noise.
	Sigma float64 `json:"sigma"`
}

// StuckParams are the parameters of a stuck transform.
type StuckParams struct {
	// Value is the reading the frozen tag reports.
	Value Value `json:"value"`
}

// DutyShiftParams are the parameters of a duty_shift transform.
type DutyShiftParams struct {
	// RunValue is the level of the digital tag that is stretched.
	RunValue bool `json:"run_value"`
	// ExtendS is how many seconds each run is extended; a negative value
	// suppresses that many seconds at the start of the run.
	ExtendS int `json:"extend_s"`
}

// DropoutParams are the parameters of a dropout transform; the value is
// optional.
type DropoutParams struct {
	// Value is the reading the dropped-out tag reports, when the definition
	// names one.
	Value *Value `json:"value,omitempty"`
}

// ParseParams decodes Params into the struct the op declares: OffsetParams,
// ScaleParams, RampParams, NoiseParams, StuckParams, DutyShiftParams or
// DropoutParams. Unknown members are rejected, because every branch of the
// schema's transform is closed.
func (t Transform) ParseParams() (any, error) {
	what := fmt.Sprintf("the parameters of the %s transform of %q", t.Op, t.Tag)
	switch t.Op {
	case OpOffset:
		var params OffsetParams
		if err := decodeClosed(t.Params, &params, what); err != nil {
			return nil, err
		}
		return params, nil
	case OpScale:
		var params ScaleParams
		if err := decodeClosed(t.Params, &params, what); err != nil {
			return nil, err
		}
		return params, nil
	case OpRamp:
		var params RampParams
		if err := decodeClosed(t.Params, &params, what); err != nil {
			return nil, err
		}
		return params, nil
	case OpNoise:
		var params NoiseParams
		if err := decodeClosed(t.Params, &params, what); err != nil {
			return nil, err
		}
		return params, nil
	case OpStuck:
		var params StuckParams
		if err := decodeClosed(t.Params, &params, what); err != nil {
			return nil, err
		}
		return params, nil
	case OpDutyShift:
		var params DutyShiftParams
		if err := decodeClosed(t.Params, &params, what); err != nil {
			return nil, err
		}
		return params, nil
	case OpDropout:
		var params DropoutParams
		if err := decodeClosed(t.Params, &params, what); err != nil {
			return nil, err
		}
		return params, nil
	default:
		return nil, fmt.Errorf("contracts: unknown transform op %q", t.Op)
	}
}

// MarshalJSON writes the flat object the schema describes: the three shared
// fields followed by the members of Params.
func (t Transform) MarshalJSON() ([]byte, error) {
	head, err := json.Marshal(struct {
		Tag  string `json:"tag"`
		When string `json:"when"`
		Op   string `json:"op"`
	}{Tag: t.Tag, When: t.When, Op: t.Op})
	if err != nil {
		return nil, fmt.Errorf("contracts: encoding the transform of %q: %w", t.Tag, err)
	}

	body, err := objectMembers(t.Params)
	if err != nil {
		return nil, fmt.Errorf("contracts: encoding the parameters of the %q transform of %q: %w", t.Op, t.Tag, err)
	}
	if len(body) == 0 {
		return head, nil
	}

	out := make([]byte, 0, len(head)+len(body)+1)
	out = append(out, head[:len(head)-1]...)
	out = append(out, ',')
	out = append(out, body...)
	out = append(out, '}')
	return out, nil
}

// UnmarshalJSON reads the flat object: tag, when and op become fields and
// every other member is kept, in the order it was written and without its
// original whitespace, as Params.
func (t *Transform) UnmarshalJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("contracts: reading a transform: %w", err)
	}
	if tok != json.Delim('{') {
		return fmt.Errorf("contracts: a transform is a JSON object, got %s", data)
	}

	read := Transform{}
	params := bytes.NewBufferString("{")
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return fmt.Errorf("contracts: reading a transform member: %w", err)
		}
		key, ok := keyTok.(string)
		if !ok {
			return fmt.Errorf("contracts: a transform member name is a string, got %v", keyTok)
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return fmt.Errorf("contracts: reading the transform member %q: %w", key, err)
		}

		switch key {
		case "tag":
			err = json.Unmarshal(raw, &read.Tag)
		case "when":
			err = json.Unmarshal(raw, &read.When)
		case "op":
			err = json.Unmarshal(raw, &read.Op)
		default:
			err = appendMember(params, key, raw)
		}
		if err != nil {
			return fmt.Errorf("contracts: reading the transform member %q: %w", key, err)
		}
	}
	if _, err := dec.Token(); err != nil {
		return fmt.Errorf("contracts: reading the end of a transform: %w", err)
	}

	params.WriteByte('}')
	read.Params = json.RawMessage(params.Bytes())
	*t = read
	return nil
}

// GtInjectionDef is one injection type the simulator offers; it never travels
// on its own, only inside a GtInjections document.
type GtInjectionDef struct {
	// InjectionID identifies the injection.
	InjectionID string `json:"injection_id"`
	// FaultID is the cause of the manual's registry it stands for.
	FaultID string `json:"fault_id"`
	// Label is the menu text, shown verbatim.
	Label string `json:"label"`
	// Benign is true when the cause is a normal operating condition.
	Benign bool `json:"benign"`
	// Description says what the injection does to the signals.
	Description string `json:"description"`
	// DefaultDurationSimMin is how long an instance runs by default.
	DefaultDurationSimMin int `json:"default_duration_sim_min"`
	// Envelope is the trapezoid an instance follows.
	Envelope InjectionEnvelope `json:"envelope"`
	// Params are the tunable instance parameters and their bounds.
	Params []InjectionParamDef `json:"params"`
	// Transforms are the per-tag overlays, applied in list order.
	Transforms []Transform `json:"transforms"`
}

// Summary is the part of the definition the user interface's menu needs; the
// transforms and the envelope stay in the simulator (gt-catalog.schema.json,
// injection_summary).
func (d GtInjectionDef) Summary() GtCatalogInjection {
	params := d.Params
	if params == nil {
		params = []InjectionParamDef{}
	}
	return GtCatalogInjection{
		InjectionID:           d.InjectionID,
		FaultID:               d.FaultID,
		Label:                 d.Label,
		Benign:                d.Benign,
		Description:           d.Description,
		DefaultDurationSimMin: d.DefaultDurationSimMin,
		Params:                params,
	}
}

// GtInjections is the document packages/ground-truth/data/injections.json.
type GtInjections struct {
	// Schema is SchemaGtInjections.
	Schema string `json:"schema"`
	// Injections is every injection type the simulator offers, in menu
	// order.
	Injections []GtInjectionDef `json:"injections"`
}

// GtFailureSource says where the failure table comes from.
type GtFailureSource struct {
	// Dataset names the recording.
	Dataset string `json:"dataset"`
	// DOI is its digital object identifier.
	DOI string `json:"doi"`
	// License is the licence the recording is published under.
	License string `json:"license"`
	// CSVSHA256 is the digest of the file the table was resolved against.
	CSVSHA256 string `json:"csv_sha256"`
	// ResolvedFrom names the document that fixed the windows.
	ResolvedFrom string `json:"resolved_from"`
}

// Failure is one scored failure of the corrected table, with the published
// values kept beside the corrected ones. Every nullable member is a pointer,
// so an unknown instant is written as null rather than dropped.
type Failure struct {
	// ID is F1 to F4, plus the addendum F4b.
	ID string `json:"id"`
	// UCINr is the number the published table gives this row, or null.
	UCINr *string `json:"uci_nr"`
	// Start is the inclusive start of the scoring window.
	Start Time `json:"start"`
	// End is its exclusive end.
	End Time `json:"end"`
	// UCIStart and UCIEnd are the published window, or null.
	UCIStart *Time `json:"uci_start"`
	UCIEnd   *Time `json:"uci_end"`
	// DataOnset is the first sample showing the signature, or null.
	DataOnset *Time `json:"data_onset"`
	// DataRecovery is the first sample after it ends, or null.
	DataRecovery *Time `json:"data_recovery"`
	// OnsetKnown is false when the logger was frozen across the onset.
	OnsetKnown bool `json:"onset_known"`
	// PrecursorFrom is the first measurable instant ahead of the window.
	PrecursorFrom *Time `json:"precursor_from"`
	// ReportLocal is the operator report on the local clock, or null.
	ReportLocal *string `json:"report_local"`
	// Maintenance is when the intervention was recorded, or null.
	Maintenance *Time `json:"maintenance"`
	// MaintenanceVerified is true when the data shows it at that hour.
	MaintenanceVerified bool `json:"maintenance_verified"`
	// FaultID is the primary cause.
	FaultID string `json:"fault_id"`
	// AcceptedFaultIDs is every cause the evaluation accepts, primary
	// first.
	AcceptedFaultIDs []string `json:"accepted_fault_ids"`
	// Signature is which data-derived leak signature this failure shows.
	Signature string `json:"signature"`
	// Component names the part that failed.
	Component string `json:"component"`
	// NativeAlarmFirst is the first controller alarm inside the window.
	NativeAlarmFirst *Time `json:"native_alarm_first"`
	// InHeadline is false for a row reported separately.
	InHeadline bool `json:"in_headline"`
	// Notes is the free commentary of the table.
	Notes string `json:"notes"`
}

// UnlabelledEpisode is an episode that looks like a labelled failure but
// carries no label; it is excluded from precision and reported separately.
type UnlabelledEpisode struct {
	// Start and End bound the episode.
	Start Time `json:"start"`
	End   Time `json:"end"`
	// Hours is its length.
	Hours float64 `json:"hours"`
	// TP3Median, DVPressureMedian and OilMax summarise the signals.
	TP3Median        float64 `json:"tp3_median"`
	DVPressureMedian float64 `json:"dv_pressure_median"`
	OilMax           float64 `json:"oil_max"`
	// FaultIDHint is the cause the episode resembles.
	FaultIDHint string `json:"fault_id_hint"`
	// Note explains the reading.
	Note string `json:"note"`
}

// ExcludedWindow is a window that counts neither as a positive nor as a
// negative; From is inclusive and To is exclusive.
type ExcludedWindow struct {
	From Time `json:"from"`
	To   Time `json:"to"`
	// Reason is why the window is excluded.
	Reason string `json:"reason"`
}

// FrozenBlock is a stretch of repeated rows written by a frozen logger.
type FrozenBlock struct {
	Start Time `json:"start"`
	End   Time `json:"end"`
	// Rows is how many rows the block holds.
	Rows int `json:"rows"`
	// Hours is its length.
	Hours float64 `json:"hours"`
}

// Gap is a stretch with no rows at all, longer than an hour.
type Gap struct {
	Start Time `json:"start"`
	End   Time `json:"end"`
	// Seconds is its length.
	Seconds int64 `json:"seconds"`
}

// GtFailureTable is the document packages/ground-truth/data/metropt3-failures.json.
type GtFailureTable struct {
	// Schema is SchemaGtFailureTable.
	Schema string `json:"schema"`
	// Source says where the table comes from.
	Source GtFailureSource `json:"source"`
	// Clock is the constant utc-assumed: the recorded timestamps carry no
	// zone and the project reads them as UTC.
	Clock string `json:"clock"`
	// Failures are the scored failures, in chronological order.
	Failures []Failure `json:"failures"`
	// UnlabelledEpisodes, ExcludedWindows, FrozenBlocks and GapsOver1h are
	// everything the evaluation keeps out of scoring.
	UnlabelledEpisodes []UnlabelledEpisode `json:"unlabelled_episodes"`
	ExcludedWindows    []ExcludedWindow    `json:"excluded_windows"`
	FrozenBlocks       []FrozenBlock       `json:"frozen_blocks"`
	GapsOver1h         []Gap               `json:"gaps_over_1h"`
}

// GtCatalogDataset is the replay source as the catalog reports it.
type GtCatalogDataset struct {
	// FirstTS and LastTS bound the recording.
	FirstTS Time `json:"first_ts"`
	LastTS  Time `json:"last_ts"`
	// Rows is how many rows the simulator indexed.
	Rows int `json:"rows"`
	// Gaps is how many recording gaps it found.
	Gaps int `json:"gaps"`
}

// GtCatalogInjection is one injection as the user interface lists it.
type GtCatalogInjection struct {
	InjectionID           string              `json:"injection_id"`
	FaultID               string              `json:"fault_id"`
	Label                 string              `json:"label"`
	Benign                bool                `json:"benign"`
	Description           string              `json:"description"`
	DefaultDurationSimMin int                 `json:"default_duration_sim_min"`
	Params                []InjectionParamDef `json:"params"`
}

// GtCatalog is what the simulator retains on gt/{unit_id}/catalog. Only the
// ground-truth readers of the broker ACL ever see it; diagnosis code must not.
type GtCatalog struct {
	Envelope
	// Dataset is the replay source being served.
	Dataset GtCatalogDataset `json:"dataset"`
	// Presets is the presets document, forwarded verbatim.
	Presets GtPresets `json:"presets"`
	// Injections is the menu subset of the injection definitions.
	// Required, so an empty menu is written as [].
	Injections []GtCatalogInjection `json:"injections"`
	// Failures is the failure-table document, forwarded verbatim.
	Failures GtFailureTable `json:"failures"`
	// SourceSHA256 is the digest over the ground-truth data files in name
	// order, so a consumer can tell one catalogue from another.
	SourceSHA256 string `json:"source_sha256,omitempty"`
}

// InstanceParams are the two parameters one injection instance runs with,
// after defaults and bounds were applied.
type InstanceParams struct {
	// Magnitude is the resolved strength.
	Magnitude float64 `json:"magnitude"`
	// DurationSimMin is the resolved length in simulated minutes.
	DurationSimMin int `json:"duration_sim_min"`
}

// GtInjection is one start or stop of an injection instance, published on
// gt/{unit_id}/injection.
type GtInjection struct {
	Envelope
	// SimTS is the data time of the event.
	SimTS Time `json:"sim_ts"`
	// Event is start or stop.
	Event string `json:"event"`
	// InstanceID identifies the running instance.
	InstanceID string `json:"instance_id"`
	// InjectionID and FaultID say what is being injected.
	InjectionID string `json:"injection_id"`
	FaultID     string `json:"fault_id"`
	// Params are the resolved instance parameters.
	Params InstanceParams `json:"params"`
	// EndsSimTS is when the instance expires, or was going to.
	EndsSimTS Time `json:"ends_sim_ts"`
	// Reason is why the instance ended; stop messages only.
	Reason string `json:"reason,omitempty"`
}

// ActiveInstance is one injection instance the simulator is applying.
type ActiveInstance struct {
	InstanceID   string         `json:"instance_id"`
	InjectionID  string         `json:"injection_id"`
	FaultID      string         `json:"fault_id"`
	StartedSimTS Time           `json:"started_sim_ts"`
	EndsSimTS    Time           `json:"ends_sim_ts"`
	Params       InstanceParams `json:"params"`
}

// GtInjectionActive is the retained list of running instances on
// gt/{unit_id}/injection/active; an empty list clears the overlay.
type GtInjectionActive struct {
	Envelope
	// SimTS is the data time the list was taken at.
	SimTS Time `json:"sim_ts"`
	// Active is every instance running at SimTS, in start order.
	// Required, so an empty list is written as [].
	Active []ActiveInstance `json:"active"`
}

// GtMarker is a discontinuity the simulator created itself, published on
// gt/{unit_id}/marker.
type GtMarker struct {
	Envelope
	// Kind is jump, reset or loop.
	Kind string `json:"kind"`
	// PresetID is the preset a jump came from; absent when the jump named
	// an instant instead.
	PresetID *string `json:"preset_id,omitempty"`
	// SimTSFrom is the instant the replay left.
	SimTSFrom Time `json:"sim_ts_from"`
	// SimTSTo is the instant it continues from.
	SimTSTo Time `json:"sim_ts_to"`
}

// decodeClosed reads a JSON object into target, refusing a member the target
// does not declare and any trailing content, the way every closed object of
// the schemas is defined. what is the phrase the error message names the
// object by, for example "the arguments of jump".
func decodeClosed(raw json.RawMessage, target any, what string) error {
	body := bytes.TrimSpace(raw)
	if len(body) == 0 {
		return fmt.Errorf("contracts: %s are missing", what)
	}

	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return fmt.Errorf("contracts: reading %s: %w", what, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return fmt.Errorf("contracts: trailing content after %s", what)
	}
	return nil
}

// objectMembers returns the members of a JSON object without its braces and
// without insignificant whitespace, or an empty slice for {}.
func objectMembers(raw json.RawMessage) ([]byte, error) {
	body := bytes.TrimSpace(raw)
	if len(body) == 0 {
		return nil, nil
	}

	var compact bytes.Buffer
	if err := json.Compact(&compact, body); err != nil {
		return nil, err
	}
	members := compact.Bytes()
	if len(members) < 2 || members[0] != '{' || members[len(members)-1] != '}' {
		return nil, fmt.Errorf("expected a JSON object, got %s", members)
	}
	return members[1 : len(members)-1], nil
}

// appendMember writes one member into an object under construction, adding the
// separating comma when the buffer already holds one. The value is compacted,
// so the result does not depend on how the source document was formatted.
func appendMember(buf *bytes.Buffer, key string, raw json.RawMessage) error {
	if buf.Len() > 1 {
		buf.WriteByte(',')
	}
	name, err := json.Marshal(key)
	if err != nil {
		return err
	}
	buf.Write(name)
	buf.WriteByte(':')
	return json.Compact(buf, raw)
}
