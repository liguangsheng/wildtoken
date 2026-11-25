package proxy

import (
	"sort"
)

// Request bodies are rewritten by splicing bytes, not by decoding and encoding
// them again. Re-encoding sorted the top-level keys, compacted every nested
// value and escaped < > & as < and the like, so a single changed field
// changed the whole body the upstream saw.

// member is one key of a JSON object and the byte range of its value.
type member struct {
	name       string
	start, end int
}

// jsonEdit replaces body[start:end] with text; start == end inserts.
type jsonEdit struct {
	start, end int
	text       []byte
}

// insertMember adds text, a `"name":value` pair, to the object whose members
// and closing brace are given, all offset by base. It goes after the last
// member, or before the closing brace of an empty object.
func insertMember(base int, members []member, closing int, text string) jsonEdit {
	if len(members) == 0 {
		return jsonEdit{start: base + closing, end: base + closing, text: []byte(text)}
	}
	at := base + members[len(members)-1].end
	return jsonEdit{start: at, end: at, text: []byte("," + text)}
}

// applyEdits returns body with the edits made; with none, body itself. The
// edits must not overlap.
func applyEdits(body []byte, edits []jsonEdit) []byte {
	if len(edits) == 0 {
		return body
	}
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].start < edits[j].start })

	size := len(body)
	for _, edit := range edits {
		size += len(edit.text) - (edit.end - edit.start)
	}
	out := make([]byte, 0, size)
	last := 0
	for _, edit := range edits {
		out = append(out, body[last:edit.start]...)
		out = append(out, edit.text...)
		last = edit.end
	}
	return append(out, body[last:]...)
}
