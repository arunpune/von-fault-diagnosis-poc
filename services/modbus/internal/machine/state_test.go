// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package machine_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"fault-diagnosis-poc/services/modbus/internal/machine"
)

func TestClassify(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		comp         bool
		dvElectric   bool
		current      float64
		want         machine.State
		wantAsString string
	}{
		{
			name: "loaded run", comp: false, dvElectric: true, current: 6.00,
			want: machine.StateLoaded, wantAsString: "loaded",
		},
		{
			name: "loaded is decided by the valves, not the current",
			comp: false, dvElectric: true, current: 0.04,
			want: machine.StateLoaded, wantAsString: "loaded",
		},
		{
			name: "run-on after cut-out", comp: true, dvElectric: false, current: 3.77,
			want: machine.StateUnloaded, wantAsString: "unloaded",
		},
		{
			name: "transitional row with both valves low", comp: false, dvElectric: false, current: 3.9,
			want: machine.StateUnloaded, wantAsString: "unloaded",
		},
		{
			name: "intake closed with the load valve on but the motor idle is still loaded",
			comp: false, dvElectric: true, current: 0,
			want: machine.StateLoaded, wantAsString: "loaded",
		},
		{
			name: "off", comp: true, dvElectric: false, current: 0.038,
			want: machine.StateOff, wantAsString: "off",
		},
		{
			name: "just below the running threshold", comp: true, dvElectric: false, current: 0.999,
			want: machine.StateOff, wantAsString: "off",
		},
		{
			name: "exactly at the running threshold", comp: true, dvElectric: false, current: 1.0,
			want: machine.StateUnloaded, wantAsString: "unloaded",
		},
		{
			name: "inside the 0.5 to 1.0 A band", comp: true, dvElectric: false, current: 0.5,
			want: machine.StateOff, wantAsString: "off",
		},
		{
			name: "start ramp above the threshold", comp: true, dvElectric: false, current: 1.06,
			want: machine.StateUnloaded, wantAsString: "unloaded",
		},
		{
			name: "both valves high is not loaded", comp: true, dvElectric: true, current: 3.8,
			want: machine.StateUnloaded, wantAsString: "unloaded",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := machine.Classify(tc.comp, tc.dvElectric, tc.current)
			assert.Equal(t, tc.want, got)
			assert.Equal(t, tc.wantAsString, got.String())
		})
	}
}

func TestStateStringOfAnUnknownValue(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "State(9)", machine.State(9).String())
}

func TestRunningThreshold(t *testing.T) {
	t.Parallel()

	assert.InDelta(t, 1.0, machine.RunningThresholdA, 0,
		"the threshold is the documented 1.0 A")
}
