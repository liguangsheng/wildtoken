package models

import (
	"math"
	"testing"
)

func TestDashboardMultiplierRange(t *testing.T) {
	for _, tc := range []struct {
		value float64
		ok    bool
	}{
		{1, true},
		{0.5, true},
		{MaxDashboardMultiplier, true},
		{0, false},
		{-1, false},
		{MaxDashboardMultiplier + 0.1, false},
		// NaN slips past a "reject out of range" check; must still be refused.
		{math.NaN(), false},
	} {
		settings := DefaultRuntimeSettings()
		settings.DashboardMultiplier = tc.value
		if err := settings.Validate(); (err == nil) != tc.ok {
			t.Errorf("multiplier %v: err = %v, want ok = %v", tc.value, err, tc.ok)
		}
	}
}
