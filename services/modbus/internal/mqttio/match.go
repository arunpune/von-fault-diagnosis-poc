// SPDX-FileCopyrightText: 2026 Meddle S.r.l.
// SPDX-License-Identifier: Apache-2.0

package mqttio

import "strings"

// Match reports whether an MQTT topic filter matches a topic name, following
// MQTT 5 §4.7:
//
//   - "+" matches exactly one topic level, including an empty one;
//   - "#" matches the rest of the topic and must be the last level, and it
//     also matches the parent level itself, so "plant/#" matches "plant";
//   - a filter that starts with a wildcard never matches a topic that starts
//     with "$", which keeps "#" away from "$SYS".
//
// It is the dispatch rule of the wrapper: the broker decides what is
// delivered, this decides which registered handlers see it.
func Match(filter, topic string) bool {
	if filter == "" || topic == "" {
		return false
	}
	if strings.HasPrefix(topic, "$") && (strings.HasPrefix(filter, "#") || strings.HasPrefix(filter, "+")) {
		return false
	}

	filterLevels := strings.Split(filter, "/")
	topicLevels := strings.Split(topic, "/")

	for i, level := range filterLevels {
		if level == "#" {
			// "#" is only a wildcard as the last level; anywhere else the
			// filter is malformed and matches nothing.
			return i == len(filterLevels)-1
		}
		if i >= len(topicLevels) {
			return false
		}
		if level != "+" && level != topicLevels[i] {
			return false
		}
	}
	return len(filterLevels) == len(topicLevels)
}
