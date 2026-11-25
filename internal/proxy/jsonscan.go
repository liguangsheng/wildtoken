package proxy

import (
	"bytes"
	"encoding/json"
	"strconv"
	"unicode/utf8"
)

// The scan below walks JSON bytes in place, validating them as encoding/json
// does. A json.Decoder copied each body into its own buffer, several times
// over as that grew: a 1 MiB request cost 4 MiB before anything was rewritten.

// objectMembers lists the members of the object body holds, in order and with
// duplicates, and the offset of its closing brace. ok is false unless body is
// exactly one JSON object, whitespace aside — what json.Unmarshal accepts.
//
// Names are compared decoded, so "model" is model here as it is to every
// JSON parser upstream.
func objectMembers(body []byte) (members []member, closing int, ok bool) {
	members, closing, _, ok = scanObject(body)
	return members, closing, ok
}

// scanObject is objectMembers that also reports whether every number in the
// body fits a float64. Decoding into interface values, as a map[string]any
// does, fails on one that does not, so callers that stand in for such a
// decode give up where it would have.
func scanObject(body []byte) (members []member, closing int, numbersFit, ok bool) {
	numbersFit = true
	i := skipJSONSpace(body, 0)
	if i >= len(body) || body[i] != '{' {
		return nil, 0, false, false
	}

	i = skipJSONSpace(body, i+1)
	if i < len(body) && body[i] == '}' {
		closing = i
	} else {
		for {
			if i >= len(body) || body[i] != '"' {
				return nil, 0, false, false
			}
			nameEnd := skipJSONString(body, i)
			if nameEnd < 0 {
				return nil, 0, false, false
			}
			name := memberName(body[i:nameEnd])

			i = skipJSONSpace(body, nameEnd)
			if i >= len(body) || body[i] != ':' {
				return nil, 0, false, false
			}
			start := skipJSONSpace(body, i+1)
			// This object is the one container already open.
			end := skipJSONValue(body, start, 1, &numbersFit)
			if end < 0 {
				return nil, 0, false, false
			}
			members = append(members, member{name: name, start: start, end: end})

			i = skipJSONSpace(body, end)
			if i >= len(body) || body[i] != ',' {
				break
			}
			i = skipJSONSpace(body, i+1)
		}
		if i >= len(body) || body[i] != '}' {
			return nil, 0, false, false
		}
		closing = i
	}

	if skipJSONSpace(body, closing+1) != len(body) {
		return nil, 0, false, false
	}
	return members, closing, numbersFit, true
}

// maxJSONDepth is encoding/json's nesting limit: a document with more
// containers open at once is not JSON to json.Unmarshal, so not JSON here.
const maxJSONDepth = 10000

// skipJSONValue returns the offset just past the value starting at i, or -1
// when there is none. open counts the containers already enclosing it, and a
// number too large for a float64 clears numbersFit. The walk keeps its own
// stack, so depth costs a byte per level, not a frame.
func skipJSONValue(body []byte, i, open int, numbersFit *bool) int {
	var stack []byte
	for {
		i = skipJSONSpace(body, i)
		if i >= len(body) {
			return -1
		}

		switch c := body[i]; {
		case c == '{' || c == '[':
			// encoding/json counts an empty container against the limit too.
			if open+len(stack)+1 > maxJSONDepth {
				return -1
			}
			closer := byte('}')
			if c == '[' {
				closer = ']'
			}
			if next := skipJSONSpace(body, i+1); next < len(body) && body[next] == closer {
				i = next + 1
				break
			}
			stack = append(stack, closer)
			if c == '{' {
				i = skipJSONKey(body, i+1)
			} else {
				i++
			}
			if i < 0 {
				return -1
			}
			continue
		case c == '"':
			i = skipJSONString(body, i)
		case c == '-' || (c >= '0' && c <= '9'):
			start := i
			i = skipJSONNumber(body, i)
			if i >= 0 && !numberFitsFloat64(body[start:i]) {
				*numbersFit = false
			}
		default:
			i = skipJSONLiteral(body, i)
		}
		if i < 0 {
			return -1
		}

		// A value ended: close containers until one expects another value.
		for {
			if len(stack) == 0 {
				return i
			}
			i = skipJSONSpace(body, i)
			if i >= len(body) {
				return -1
			}
			closer := stack[len(stack)-1]
			if body[i] == ',' {
				if closer == '}' {
					i = skipJSONKey(body, i+1)
				} else {
					i++
				}
				if i < 0 {
					return -1
				}
				break
			}
			if body[i] != closer {
				return -1
			}
			stack = stack[:len(stack)-1]
			i++
		}
	}
}

// skipJSONKey reads an object key and its colon, returning where the value
// starts, or -1.
func skipJSONKey(body []byte, i int) int {
	i = skipJSONSpace(body, i)
	if i >= len(body) || body[i] != '"' {
		return -1
	}
	if i = skipJSONString(body, i); i < 0 {
		return -1
	}
	i = skipJSONSpace(body, i)
	if i >= len(body) || body[i] != ':' {
		return -1
	}
	return i + 1
}

// skipJSONString returns the offset just past the string whose quote is at i,
// or -1. Bytes of 0x80 and up pass as they are: encoding/json decodes invalid
// UTF-8 to U+FFFD rather than rejecting it.
func skipJSONString(body []byte, i int) int {
	for i++; i < len(body); i++ {
		switch c := body[i]; {
		case c == '"':
			return i + 1
		case c < 0x20:
			return -1
		case c == '\\':
			i++
			if i >= len(body) {
				return -1
			}
			switch body[i] {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
			case 'u':
				if i+4 >= len(body) {
					return -1
				}
				for k := 1; k <= 4; k++ {
					if !isHexDigit(body[i+k]) {
						return -1
					}
				}
				i += 4
			default:
				return -1
			}
		}
	}
	return -1
}

// skipJSONNumber returns the offset just past the number at i, or -1:
// -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
func skipJSONNumber(body []byte, i int) int {
	if body[i] == '-' {
		i++
	}
	switch {
	case i < len(body) && body[i] == '0':
		i++
	case i < len(body) && body[i] >= '1' && body[i] <= '9':
		i = skipJSONDigits(body, i)
	default:
		return -1
	}
	if i < len(body) && body[i] == '.' {
		if i = skipJSONDigits(body, i+1); i < 0 {
			return -1
		}
	}
	if i < len(body) && (body[i] == 'e' || body[i] == 'E') {
		i++
		if i < len(body) && (body[i] == '+' || body[i] == '-') {
			i++
		}
		if i = skipJSONDigits(body, i); i < 0 {
			return -1
		}
	}
	return i
}

// numberFitsFloat64 reports whether strconv.ParseFloat, as encoding/json uses
// it, accepts a valid number. Only overflow fails, and without an exponent a
// number of up to 308 integer digits cannot overflow.
func numberFitsFloat64(number []byte) bool {
	digits := bytes.TrimPrefix(number, []byte("-"))
	if !bytes.ContainsAny(digits, "eE") {
		if dot := bytes.IndexByte(digits, '.'); dot >= 0 {
			digits = digits[:dot]
		}
		if len(digits) <= 308 {
			return true
		}
	}
	_, err := strconv.ParseFloat(string(number), 64)
	return err == nil
}

// skipJSONDigits returns the offset after one or more digits at i, or -1.
func skipJSONDigits(body []byte, i int) int {
	start := i
	for i < len(body) && body[i] >= '0' && body[i] <= '9' {
		i++
	}
	if i == start {
		return -1
	}
	return i
}

func skipJSONLiteral(body []byte, i int) int {
	for _, literal := range [...]string{"true", "false", "null"} {
		if len(body)-i >= len(literal) && string(body[i:i+len(literal)]) == literal {
			return i + len(literal)
		}
	}
	return -1
}

func skipJSONSpace(body []byte, i int) int {
	for i < len(body) && isJSONSpace(body[i]) {
		i++
	}
	return i
}

func isJSONSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// memberName decodes a quoted name the scan has validated. Nearly every name
// is plain ASCII and is taken as it stands.
func memberName(quoted []byte) string {
	raw := quoted[1 : len(quoted)-1]
	if bytes.IndexByte(raw, '\\') < 0 && utf8.Valid(raw) {
		return string(raw)
	}
	var name string
	if err := json.Unmarshal(quoted, &name); err != nil {
		return string(raw)
	}
	return name
}
