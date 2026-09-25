// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package contracts_test

import (
	"encoding/json"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"fault-diagnosis-poc/services/modbus/internal/contracts"
)

// isoTS is the pattern common.schema.json holds a timestamp to. The Go
// formatter has to satisfy it for every instant, not only for the ones the
// fixtures happen to carry.
var isoTS = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

// TestTimeMarshalsToTheContractFormat covers the three ways an instant can
// arrive wrongly formatted: a zone other than UTC, a sub-millisecond
// remainder, and a millisecond that needs padding.
func TestTimeMarshalsToTheContractFormat(t *testing.T) {
	t.Parallel()

	plusTwo := time.FixedZone("test+02", 2*60*60)

	cases := []struct {
		name  string
		given time.Time
		want  string
	}{
		{
			name:  "a whole second is padded to three digits",
			given: time.Date(2020, time.April, 18, 0, 0, 0, 0, time.UTC),
			want:  "2020-04-18T00:00:00.000Z",
		},
		{
			name:  "a single millisecond is padded to three digits",
			given: time.Date(2020, time.June, 5, 10, 28, 20, int(4*time.Millisecond), time.UTC),
			want:  "2020-06-05T10:28:20.004Z",
		},
		{
			name:  "a sub-millisecond remainder is truncated, never rounded",
			given: time.Date(2020, time.June, 5, 10, 28, 20, 999_999, time.UTC),
			want:  "2020-06-05T10:28:20.000Z",
		},
		{
			name:  "an offset zone is converted to UTC",
			given: time.Date(2020, time.June, 5, 12, 28, 20, int(7*time.Millisecond), plusTwo),
			want:  "2020-06-05T10:28:20.007Z",
		},
		{
			name:  "epoch milliseconds keep their millisecond",
			given: time.UnixMilli(1591352900007).UTC(),
			want:  "2020-06-05T10:28:20.007Z",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			encoded, err := json.Marshal(contracts.Time{Time: tc.given})
			require.NoError(t, err)
			require.JSONEq(t, `"`+tc.want+`"`, string(encoded))
			require.True(t, isoTS.MatchString(tc.want), "%s does not match the iso_ts pattern", tc.want)
			require.Equal(t, tc.want, contracts.Time{Time: tc.given}.String())
		})
	}
}

// TestTimeUnmarshalsOnlyTheContractFormat is the strictness half: a timestamp
// a consumer's iso_ts pattern would reject must not decode here either.
func TestTimeUnmarshalsOnlyTheContractFormat(t *testing.T) {
	t.Parallel()

	accepted := []struct {
		text string
		want time.Time
	}{
		{"2020-04-18T00:00:00.000Z", time.Date(2020, time.April, 18, 0, 0, 0, 0, time.UTC)},
		{"2020-06-05T10:28:20.007Z", time.Date(2020, time.June, 5, 10, 28, 20, int(7*time.Millisecond), time.UTC)},
	}
	for _, tc := range accepted {
		t.Run("accepts "+tc.text, func(t *testing.T) {
			t.Parallel()

			var decoded contracts.Time
			require.NoError(t, json.Unmarshal([]byte(`"`+tc.text+`"`), &decoded))
			require.True(t, decoded.Equal(tc.want), "got %s, want %s", decoded, tc.want)
			require.Equal(t, time.UTC, decoded.Location())
		})
	}

	rejected := []struct {
		name string
		text string
	}{
		{"no fractional second", `"2020-04-18T00:00:00Z"`},
		{"microseconds", `"2020-04-18T00:00:00.000000Z"`},
		{"one fractional digit", `"2020-04-18T00:00:00.0Z"`},
		{"a numeric offset", `"2020-04-18T00:00:00.000+01:00"`},
		{"no zone at all", `"2020-04-18T00:00:00.000"`},
		{"a single-digit month", `"2020-4-18T00:00:00.000Z"`},
		{"a space instead of T", `"2020-04-18 00:00:00.000Z"`},
		{"trailing text", `"2020-04-18T00:00:00.000Z "`},
		{"not a timestamp", `"yesterday"`},
		{"a number", `1587168000000`},
		{"a null", `null`},
	}
	for _, tc := range rejected {
		t.Run("rejects "+tc.name, func(t *testing.T) {
			t.Parallel()

			var decoded contracts.Time
			require.Error(t, json.Unmarshal([]byte(tc.text), &decoded), "%s decoded as %s", tc.text, decoded)
		})
	}
}

// TestParseTimeAndFromUnixMilliAgree keeps the two constructors on one clock:
// the register model carries epoch milliseconds and the envelope carries text,
// and a value has to survive the trip between them.
func TestParseTimeAndFromUnixMilliAgree(t *testing.T) {
	t.Parallel()

	const ms int64 = 1591352900007

	fromMillis := contracts.FromUnixMilli(ms)
	parsed, err := contracts.ParseTime("2020-06-05T10:28:20.007Z")
	require.NoError(t, err)

	require.Equal(t, fromMillis, parsed)
	require.Equal(t, ms, parsed.UnixMilli())

	_, err = contracts.ParseTime("2020-06-05T10:28:20Z")
	require.Error(t, err)
}

// TestNowIsUTCAndSurvivesARoundTrip pins the only clock-reading function of
// the package: it must not leak a local zone and must not carry a precision
// the wire drops.
func TestNowIsUTCAndSurvivesARoundTrip(t *testing.T) {
	t.Parallel()

	now := contracts.Now()
	require.Equal(t, time.UTC, now.Location())
	require.Zero(t, now.Nanosecond()%int(time.Millisecond), "Now keeps a precision the wire cannot carry")

	encoded, err := json.Marshal(now)
	require.NoError(t, err)

	var decoded contracts.Time
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	require.True(t, decoded.Equal(now.Time), "Now() = %s came back as %s", now, decoded)
	require.Equal(t, now.String(), decoded.String())
}
