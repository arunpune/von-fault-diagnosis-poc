// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package gate

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ReportSchema is the document id the JSON summary carries, so a later reader
// can tell this shape from a diagnosis report.
const ReportSchema = "urn:fdp:report:sim-gate:v1"

// Task names the check that owns the gate; it is written into the summary so a
// reader can tell where the numbers came from.
const Task = "sim-signal-gate"

// Threshold is how many of the ten scenarios of known ground truth must pass:
// at least eight.
const Threshold = 8

// Total is how many scenarios the gate runs.
const Total = 10

// Kind says which of the three families a scenario belongs to.
type Kind string

// The three families of the gate.
const (
	// KindPreset jumps to a failure preset of the recording and looks for the
	// native CTRL-7 alarm the manual assigns to its signature.
	KindPreset Kind = "preset"
	// KindInjection starts one injection on the baseline segment and compares
	// the published tags against an un-injected control run.
	KindInjection Kind = "injection"
	// KindNegative replays the baseline segment with nothing injected and
	// requires the controller to stay quiet.
	KindNegative Kind = "negative"
)

// EvidenceKind says what one measurement measured.
type EvidenceKind string

// The four kinds of evidence a scenario can produce.
const (
	// EvidenceAlarm is a native alarm code seen on the wire.
	EvidenceAlarm EvidenceKind = "alarm"
	// EvidenceTag is the extreme move of one tag against the control run.
	EvidenceTag EvidenceKind = "tag"
	// EvidenceScatter is the deviation a noise transform added.
	EvidenceScatter EvidenceKind = "scatter"
	// EvidenceQuiet is the absence of a sustained alarm.
	EvidenceQuiet EvidenceKind = "quiet"
)

// Evidence is one measurement behind a verdict. Observed and Required are in
// the unit Detail names; for an alarm they are unused and SimTS carries the
// instant instead.
type Evidence struct {
	Kind EvidenceKind `json:"kind"`
	// Code is the alarm code, for EvidenceAlarm.
	Code string `json:"code,omitempty"`
	// Tag is the telemetry key, for EvidenceTag and EvidenceScatter.
	Tag string `json:"tag,omitempty"`
	// Op is the injection primitive the tag was moved by.
	Op string `json:"op,omitempty"`
	// Direction is "up" or "down": the way the definition declares the move.
	Direction string `json:"direction,omitempty"`
	// SimTS is the first simulated instant the evidence was seen at.
	SimTS string `json:"sim_ts,omitempty"`
	// Observed is what the run measured, Required the bound it had to clear.
	Observed float64 `json:"observed"`
	Required float64 `json:"required"`
	// Samples is how many published samples the measurement rests on.
	Samples int `json:"samples"`
	// Detail is one English sentence naming the rule that was applied.
	Detail string `json:"detail"`
	// OK is whether this measurement cleared its bound.
	OK bool `json:"ok"`
}

// Window is the stretch of the recording a scenario replayed.
type Window struct {
	From  string `json:"from"`
	Until string `json:"until"`
}

// Scenario is one of the ten verdicts.
type Scenario struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Kind Kind   `json:"kind"`
	// Subject is the preset id, the injection id or the replayed segment.
	Subject string `json:"subject"`
	// Signature is the failure signature a preset scenario expected ("A" or
	// "B"); empty for the other kinds.
	Signature string `json:"signature,omitempty"`
	Window    Window `json:"window"`
	// Samples is how many published samples the scenario read.
	Samples  int        `json:"samples"`
	Passed   bool       `json:"passed"`
	Evidence []Evidence `json:"evidence"`
	// Note is why a scenario failed, or what a reader should know about a
	// verdict that was reached the unusual way.
	Note string `json:"note,omitempty"`
}

// Line renders one scenario as the PASS/FAIL line the test output carries.
func (s Scenario) Line() string {
	verdict := "FAIL"
	if s.Passed {
		verdict = "PASS"
	}

	parts := make([]string, 0, len(s.Evidence))
	for _, e := range s.Evidence {
		parts = append(parts, e.String())
	}
	line := fmt.Sprintf("%s  %2d/%d %-11s %-28s %s",
		verdict, s.ID, Total, s.Kind, s.Subject, strings.Join(parts, "; "))
	if s.Note != "" {
		line += " — " + s.Note
	}
	return line
}

// String renders one measurement for the test output.
func (e Evidence) String() string {
	switch e.Kind {
	case EvidenceAlarm:
		return fmt.Sprintf("%s at %s", e.Code, e.SimTS)
	case EvidenceQuiet:
		return fmt.Sprintf("%s (%.0f s ≤ %.0f s over %d samples)",
			e.Detail, e.Observed, e.Required, e.Samples)
	case EvidenceTag, EvidenceScatter:
		return fmt.Sprintf("%s %s %s %+.4g (need %+.4g, %d samples)",
			e.Tag, e.Op, e.Direction, e.Observed, e.Required, e.Samples)
	default:
		return e.Detail
	}
}

// Report is the JSON summary of one run of the gate.
type Report struct {
	Schema string `json:"schema"`
	Task   string `json:"task"`
	// Slice is the name of the MetroPT-3 slice the run replayed.
	Slice string `json:"slice"`
	// Speed is the replay speed every scenario ran at.
	Speed uint16 `json:"speed"`
	// WallTS is when the run finished, in the envelope's instant format.
	WallTS    string `json:"wall_ts"`
	Threshold int    `json:"threshold"`
	Total     int    `json:"total"`
	Passed    int    `json:"passed"`
	// NegativePassed is whether the baseline scenario was among the passes;
	// a gate that only ever says "fault" must not pass.
	NegativePassed bool `json:"negative_passed"`
	Pass           bool `json:"pass"`
	// Missed names the scenarios that failed, in scenario order.
	Missed    []string   `json:"missed"`
	Scenarios []Scenario `json:"scenarios"`
}

// NewReport starts a summary of a run over slice at speed.
func NewReport(slice string, speed uint16, wallTS string) *Report {
	return &Report{
		Schema: ReportSchema, Task: Task, Slice: slice, Speed: speed, WallTS: wallTS,
		Threshold: Threshold, Total: Total, Missed: []string{}, Scenarios: []Scenario{},
	}
}

// Add records one verdict.
func (r *Report) Add(s Scenario) { r.Scenarios = append(r.Scenarios, s) }

// Summarise counts the verdicts and applies the threshold rule. It is called
// once every scenario has been added, and again after a change, so it never
// accumulates.
func (r *Report) Summarise() {
	r.Passed, r.NegativePassed, r.Missed = 0, false, []string{}
	for _, s := range r.Scenarios {
		if s.Passed {
			r.Passed++
			if s.Kind == KindNegative {
				r.NegativePassed = true
			}
			continue
		}
		r.Missed = append(r.Missed, fmt.Sprintf("%d %s (%s)", s.ID, s.Subject, s.Kind))
	}
	// "≥ 8/10 with the negative scenario included": a run that alarms on a
	// clean baseline has not shown that the signal is the fault's, so the
	// negative is a condition of the gate and not one vote among ten.
	r.Pass = r.Passed >= r.Threshold && r.NegativePassed
}

// Verdict renders the one-line summary the test prints last.
func (r *Report) Verdict() string {
	state := "FAILED"
	if r.Pass {
		state = "passed"
	}
	return fmt.Sprintf("signal-level gate %s: %d/%d scenarios (threshold %d, negative passed: %t)",
		state, r.Passed, r.Total, r.Threshold, r.NegativePassed)
}

// Write renders the summary to path, creating the directory it names. It is a
// no-op for an empty path, so a run without FDP_GATE_REPORT writes nothing.
func (r *Report) Write(path string) error {
	if path == "" {
		return nil
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return fmt.Errorf("gate: creating %s: %w", dir, err)
		}
	}

	body, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return fmt.Errorf("gate: rendering the summary: %w", err)
	}
	if err := os.WriteFile(path, append(body, '\n'), 0o600); err != nil {
		return fmt.Errorf("gate: writing %s: %w", path, err)
	}
	return nil
}
