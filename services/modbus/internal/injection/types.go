// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package injection

import "slices"

// CatalogSchema is the document schema id injections.json carries (the JSON
// Schema itself is packages/contracts/schemas/v1/gt-injections.schema.json).
const CatalogSchema = "urn:fdp:schema:gt-injections:v1"

// MaxDurationSimMin is the longest an instance may run, ten simulated days.
const MaxDurationSimMin = 14400

// MagnitudeParam is the parameter every definition must offer: the factor the
// envelope is multiplied by.
const MagnitudeParam = "magnitude"

// DurationParam is the instance parameter every definition accepts implicitly;
// its default is the definition's default_duration_sim_min.
const DurationParam = "duration_sim_min"

// Op is one of the seven overlay primitives.
type Op string

// The seven primitives.
const (
	// OpOffset adds value·m to an analog value.
	OpOffset Op = "offset"
	// OpScale multiplies an analog value by 1+(factor−1)·m.
	OpScale Op = "scale"
	// OpRamp adds a capped drift of rate_per_min·m per simulated minute since
	// its anchor to an analog value.
	OpRamp Op = "ramp"
	// OpNoise adds a zero-mean normal draw of deviation sigma·m to an analog
	// value.
	OpNoise Op = "noise"
	// OpStuck freezes a tag of either kind at a fixed reading.
	OpStuck Op = "stuck"
	// OpDutyShift stretches or suppresses the runs of a digital tag.
	OpDutyShift Op = "duty_shift"
	// OpDropout reports an implausible reading: a fixed number on an analog
	// tag, false on a digital one.
	OpDropout Op = "dropout"
)

// When is the machine-state guard of a transform.
type When string

// The five guards.
const (
	// WhenAny applies in every state.
	WhenAny When = "any"
	// WhenLoaded applies while the unit compresses.
	WhenLoaded When = "loaded"
	// WhenNotLoaded applies while the unit does not compress, running or not.
	WhenNotLoaded When = "not_loaded"
	// WhenUnloaded applies while the motor runs with the intake closed.
	WhenUnloaded When = "unloaded"
	// WhenOff applies while the motor is stopped.
	WhenOff When = "off"
)

// Anchor is where a ramp measures its elapsed minutes from.
type Anchor string

// The three anchors.
const (
	// AnchorInjectionStart measures from the start of the instance.
	AnchorInjectionStart Anchor = "injection_start"
	// AnchorStateEntry restarts the ramp at every change of the machine state.
	AnchorStateEntry Anchor = "state_entry"
	// AnchorGuardEntry restarts the ramp each time the transform's guard
	// starts to hold, and keeps it running through changes of machine state
	// that stay inside the guard: under not_loaded, one idle period is one
	// ramp, however often the unit goes from unloaded to off within it.
	AnchorGuardEntry Anchor = "guard_entry"
)

// Envelope is the trapezoid shape of a definition, in simulated minutes: the
// magnitude rises over RampInMin, holds at one and falls over RampOutMin.
type Envelope struct {
	RampInMin  int `json:"ramp_in_min"`
	RampOutMin int `json:"ramp_out_min"`
}

// ParamDef is one tunable instance parameter with its default and its bounds.
type ParamDef struct {
	Name    string  `json:"name"`
	Default float64 `json:"default"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
}

// Transform is one overlay on one tag. Tag, Op and When are always set; the
// remaining fields belong to one primitive each, and a definition that sets a
// field its op does not use is rejected at load.
type Transform struct {
	Tag  string `json:"tag"`
	Op   Op     `json:"op"`
	When When   `json:"when"`

	// Value is the amount an offset adds and the reading a stuck or a dropout
	// tag reports; it is a number on an analog tag and a boolean on a digital
	// one, which is why it is not a plain float64.
	Value      Scalar  `json:"value,omitzero"`
	Factor     float64 `json:"factor,omitempty"`
	RatePerMin float64 `json:"rate_per_min,omitempty"`
	Cap        float64 `json:"cap,omitempty"`
	Sigma      float64 `json:"sigma,omitempty"`
	Anchor     Anchor  `json:"anchor,omitempty"`
	RunValue   bool    `json:"run_value,omitempty"`
	ExtendS    int     `json:"extend_s,omitempty"`
}

// Definition is one injection type: what the control plane's inject command
// names and what the retained gt catalog advertises.
type Definition struct {
	InjectionID           string      `json:"injection_id"`
	FaultID               string      `json:"fault_id"`
	Label                 string      `json:"label"`
	Benign                bool        `json:"benign"`
	Description           string      `json:"description"`
	DefaultDurationSimMin int         `json:"default_duration_sim_min"`
	Envelope              Envelope    `json:"envelope"`
	Params                []ParamDef  `json:"params"`
	Transforms            []Transform `json:"transforms"`
}

// Param returns the definition of the named parameter.
func (d *Definition) Param(name string) (ParamDef, bool) {
	i := slices.IndexFunc(d.Params, func(p ParamDef) bool { return p.Name == name })
	if i < 0 {
		return ParamDef{}, false
	}
	return d.Params[i], true
}

// Catalog is the injections.json document.
type Catalog struct {
	Schema     string       `json:"schema"`
	Injections []Definition `json:"injections"`
}

// Definition returns the injection type with this id.
func (c *Catalog) Definition(injectionID string) (*Definition, bool) {
	i := slices.IndexFunc(c.Injections, func(d Definition) bool {
		return d.InjectionID == injectionID
	})
	if i < 0 {
		return nil, false
	}
	return &c.Injections[i], true
}
