// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"

	"fault-diagnosis-poc/services/modbus/internal/regmap"
)

// identifierRE is the manual's identifier grammar, repeated from
// packages/contracts/schemas/v1/common.schema.json so a hand-edited catalog
// fails here and not in a service further down the line.
var identifierRE = regexp.MustCompile(`^[a-z][a-z0-9_]{1,39}$`)

// LoadCatalog reads injections.json and validates it against the signal table
// the simulator runs with: a tag the register map does not declare, a
// primitive on the wrong kind of tag, an envelope longer than the default
// duration or a missing magnitude parameter is an error that names the
// injection and the field.
func LoadCatalog(path string, signals []regmap.Signal) (*Catalog, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("injection: opening the catalog: %w", err)
	}
	defer func() { _ = file.Close() }()

	dec := json.NewDecoder(file)
	dec.DisallowUnknownFields()

	var cat Catalog
	if err := dec.Decode(&cat); err != nil {
		return nil, fmt.Errorf("injection: reading %s: %w", path, err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("injection: %s has trailing content after the document", path)
	}
	if err := cat.Validate(signals); err != nil {
		return nil, fmt.Errorf("injection: %s: %w", path, err)
	}
	return &cat, nil
}

// Validate checks the catalog against the signal table. It is exported so a
// caller that builds a catalog in memory — a test, or a future control
// command that uploads one — goes through the same rules as the file loader.
func (c *Catalog) Validate(signals []regmap.Signal) error {
	if c.Schema != CatalogSchema {
		return fmt.Errorf("schema is %q, not %q", c.Schema, CatalogSchema)
	}
	if len(c.Injections) == 0 {
		return errors.New("injections is empty; the catalog must offer at least one injection")
	}

	kinds := make(map[string]regmap.Kind, len(signals))
	for _, sig := range signals {
		kinds[sig.Tag] = sig.Kind
	}

	seen := make(map[string]struct{}, len(c.Injections))
	for i := range c.Injections {
		def := &c.Injections[i]
		if _, dup := seen[def.InjectionID]; dup {
			return fmt.Errorf("injection %q: injection_id is declared twice", def.InjectionID)
		}
		seen[def.InjectionID] = struct{}{}
		if err := def.validate(kinds); err != nil {
			return fmt.Errorf("injection %q: %w", def.InjectionID, err)
		}
	}
	return nil
}

// validate checks one definition; the caller adds the injection id to the
// message.
func (d *Definition) validate(kinds map[string]regmap.Kind) error {
	if !identifierRE.MatchString(d.InjectionID) {
		return fmt.Errorf("injection_id %q is not an identifier", d.InjectionID)
	}
	if !identifierRE.MatchString(d.FaultID) {
		return fmt.Errorf("fault_id %q is not an identifier", d.FaultID)
	}
	if d.Label == "" {
		return errors.New("label is empty")
	}
	if d.Description == "" {
		return errors.New("description is empty")
	}
	if d.DefaultDurationSimMin < 1 || d.DefaultDurationSimMin > MaxDurationSimMin {
		return fmt.Errorf("default_duration_sim_min is %d, outside 1..%d",
			d.DefaultDurationSimMin, MaxDurationSimMin)
	}
	if d.Envelope.RampInMin < 0 || d.Envelope.RampOutMin < 0 {
		return fmt.Errorf("envelope ramp_in_min %d and ramp_out_min %d must not be negative",
			d.Envelope.RampInMin, d.Envelope.RampOutMin)
	}
	if d.Envelope.RampInMin+d.Envelope.RampOutMin > d.DefaultDurationSimMin {
		return fmt.Errorf("envelope ramp_in_min %d plus ramp_out_min %d exceeds "+
			"default_duration_sim_min %d, so the hold would be negative",
			d.Envelope.RampInMin, d.Envelope.RampOutMin, d.DefaultDurationSimMin)
	}
	if err := d.validateParams(); err != nil {
		return err
	}
	if len(d.Transforms) == 0 {
		return errors.New("transforms is empty; an injection that changes nothing is not one")
	}
	for i, tr := range d.Transforms {
		if err := tr.validate(kinds); err != nil {
			return fmt.Errorf("transforms[%d]: %w", i, err)
		}
	}
	return nil
}

// validateParams checks the parameter declarations of one definition.
func (d *Definition) validateParams() error {
	if len(d.Params) == 0 {
		return errors.New("params is empty; every injection declares magnitude")
	}
	names := make(map[string]struct{}, len(d.Params))
	for i, p := range d.Params {
		if !identifierRE.MatchString(p.Name) {
			return fmt.Errorf("params[%d].name %q is not an identifier", i, p.Name)
		}
		if _, dup := names[p.Name]; dup {
			return fmt.Errorf("params[%d].name %q is declared twice", i, p.Name)
		}
		names[p.Name] = struct{}{}
		if p.Min > p.Max {
			return fmt.Errorf("params[%d] (%s): min %g is above max %g", i, p.Name, p.Min, p.Max)
		}
		if p.Default < p.Min || p.Default > p.Max {
			return fmt.Errorf("params[%d] (%s): default %g is outside %g..%g",
				i, p.Name, p.Default, p.Min, p.Max)
		}
	}
	if _, ok := names[MagnitudeParam]; !ok {
		return fmt.Errorf("params declares no %q", MagnitudeParam)
	}
	return nil
}

// analogOnly are the primitives that read and write a number.
var analogOnly = []Op{OpOffset, OpScale, OpRamp, OpNoise}

// digitalOnly are the primitives that only make sense on a two-level tag.
var digitalOnly = []Op{OpDutyShift}

// validate checks one transform against the signal table; the caller adds the
// injection id and the transform index to the message.
func (t Transform) validate(kinds map[string]regmap.Kind) error {
	kind, known := kinds[t.Tag]
	if !known {
		return fmt.Errorf("tag %q is not a signal of the register map", t.Tag)
	}
	if _, ok := opFields[t.Op]; !ok {
		return fmt.Errorf("op %q is not one of the seven primitives", t.Op)
	}
	if !t.When.valid() {
		return fmt.Errorf("when %q is not a state guard", t.When)
	}
	if kind == regmap.KindDigital && slices.Contains(analogOnly, t.Op) {
		return fmt.Errorf("op %q reads a number but %q is a digital tag", t.Op, t.Tag)
	}
	if kind == regmap.KindAnalog && slices.Contains(digitalOnly, t.Op) {
		return fmt.Errorf("op %q reads a two-level signal but %q is an analog tag", t.Op, t.Tag)
	}
	if extra := t.extraneousFields(); len(extra) != 0 {
		return fmt.Errorf("op %q does not take %v", t.Op, extra)
	}
	return t.validateOpFields(kind)
}

// validateOpFields checks the parameters the transform's own primitive needs.
func (t Transform) validateOpFields(kind regmap.Kind) error {
	switch t.Op {
	case OpOffset:
		if !t.Value.IsSet() || t.Value.IsBool() {
			return errors.New("offset needs a numeric value")
		}
	case OpScale:
		if t.Factor <= 0 {
			return fmt.Errorf("scale needs a positive factor, not %g", t.Factor)
		}
	case OpRamp:
		if t.Anchor != AnchorInjectionStart && t.Anchor != AnchorStateEntry &&
			t.Anchor != AnchorGuardEntry {
			return fmt.Errorf("anchor %q is not one of %q, %q or %q",
				t.Anchor, AnchorInjectionStart, AnchorStateEntry, AnchorGuardEntry)
		}
		if t.Cap < 0 {
			return fmt.Errorf("ramp cap %g must not be negative", t.Cap)
		}
		if t.RatePerMin == 0 {
			return errors.New("ramp needs a non-zero rate_per_min")
		}
	case OpNoise:
		if t.Sigma < 0 {
			return fmt.Errorf("noise sigma %g must not be negative", t.Sigma)
		}
	case OpStuck:
		if !t.Value.IsSet() {
			return errors.New("stuck needs a value to freeze the tag at")
		}
		return t.Value.matches(kind, t.Tag)
	case OpDutyShift:
		if t.ExtendS == 0 {
			return errors.New("duty_shift needs a non-zero extend_s")
		}
	case OpDropout:
		if t.Value.IsSet() {
			return t.Value.matches(kind, t.Tag)
		}
	}
	return nil
}

// opFields lists the parameter keys each primitive uses, besides tag, op and
// when. It is the closed branch list of gt-injection-def.schema.json, so a
// transform that sets a field of another primitive is caught here rather than
// silently ignored.
var opFields = map[Op][]string{
	OpOffset:    {"value"},
	OpScale:     {"factor"},
	OpRamp:      {"rate_per_min", "cap", "anchor"},
	OpNoise:     {"sigma"},
	OpStuck:     {"value"},
	OpDutyShift: {"run_value", "extend_s"},
	OpDropout:   {"value"},
}

// extraneousFields names the parameter fields the transform sets although its
// own primitive does not read them.
func (t Transform) extraneousFields() []string {
	set := map[string]bool{
		"value":        t.Value.IsSet(),
		"factor":       t.Factor != 0,
		"rate_per_min": t.RatePerMin != 0,
		"cap":          t.Cap != 0,
		"sigma":        t.Sigma != 0,
		"anchor":       t.Anchor != "",
		"run_value":    t.RunValue,
		"extend_s":     t.ExtendS != 0,
	}
	var extra []string
	for _, field := range []string{
		"value", "factor", "rate_per_min", "cap", "sigma", "anchor", "run_value", "extend_s",
	} {
		if set[field] && !slices.Contains(opFields[t.Op], field) {
			extra = append(extra, field)
		}
	}
	return extra
}

// valid reports whether the guard is one of the five states.
func (w When) valid() bool {
	switch w {
	case WhenAny, WhenLoaded, WhenNotLoaded, WhenUnloaded, WhenOff:
		return true
	default:
		return false
	}
}
