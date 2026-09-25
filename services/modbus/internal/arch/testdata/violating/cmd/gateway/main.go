// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

// Command gateway is the intentional violation: it imports internal/regmap,
// which the boundary allows, and internal/sim, which it forbids.
package main

import (
	"fmt"

	"example.com/violating/internal/regmap"
	"example.com/violating/internal/sim"
)

func main() {
	fmt.Println(regmap.Tag(), sim.Replay())
}
