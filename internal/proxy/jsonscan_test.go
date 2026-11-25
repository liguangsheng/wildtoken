package proxy

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// decoderMembers is the json.Decoder walk objectMembers replaced, kept as the
// reference the scan must agree with.
func decoderMembers(body []byte) ([]member, int, bool) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, 0, false
	}
	var members []member
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, 0, false
		}
		name, isName := token.(string)
		if !isName {
			return nil, 0, false
		}
		afterName := int(decoder.InputOffset())
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			return nil, 0, false
		}
		end := int(decoder.InputOffset())
		start := afterName
		for start < end && (isJSONSpace(body[start]) || body[start] == ':') {
			start++
		}
		members = append(members, member{name: name, start: start, end: end})
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, 0, false
	}
	closing := int(decoder.InputOffset()) - 1
	if skipJSONSpace(body, closing+1) != len(body) {
		return nil, 0, false
	}
	return members, closing, true
}

// isJSONObject is what json.Unmarshal accepts as a body objectMembers serves.
func isJSONObject(body []byte) bool {
	start := skipJSONSpace(body, 0)
	return json.Valid(body) && start < len(body) && body[start] == '{'
}

func checkScanAgrees(t *testing.T, body []byte) {
	t.Helper()
	members, closing, numbersFit, ok := scanObject(body)
	if ok != isJSONObject(body) {
		t.Fatalf("objectMembers(%q) ok = %v, json.Valid says %v", body, ok, !ok)
	}
	if !ok {
		return
	}
	var decoded map[string]any
	if decodes := json.Unmarshal(body, &decoded) == nil; numbersFit != decodes {
		t.Fatalf("scanObject(%q) numbersFit = %v, map decoding succeeds: %v", body, numbersFit, decodes)
	}
	wantMembers, wantClosing, wantOK := decoderMembers(body)
	if !wantOK || closing != wantClosing || !reflect.DeepEqual(members, wantMembers) {
		t.Fatalf("objectMembers(%q) = %v, %d; decoder walk = %v, %d, %v",
			body, members, closing, wantMembers, wantClosing, wantOK)
	}
}

func TestScanAgreesWithEncodingJSONOnEdgeCases(t *testing.T) {
	for _, body := range []string{
		`{}`, ` { } `, `{"a":1}`, `{"a":01}`, `{"a":-}`, `{"a":1.}`, `{"a":.5}`, `{"a":1e}`,
		`{"a":1e+}`, `{"a":-0}`, `{"a":0.0e-0}`, `{"a":1E+2}`, `{"a":"\x"}`, `{"a":"\u12g4"}`,
		"{\"a\":\"\x01\"}", `{"a":"\u0041"}`, `{"a":tru}`, `{"a":nul}`, `{"a":falsey}`,
		`{"a":1,}`, `{,}`, `{"a":1} x`, `[]`, `1`, `"x"`, "\ufeff{}", `{"a":[1,2,]}`,
		`{"a":{"b":{"c":[[]]}}}`, `{"a" : 1 , "a":2}`, `{"a":"\"}`, `{"\u0000":1}`,
		`{"mod\u0065l":"m"}`, "{\"a\":\"\xff\xfe\"}", "{\"\xff\":1}", `{"a":[{"b":[]},{}]}`,
		`{"a":"`, `{"a"`, `{"a":`, `{`, ``, ` `, `{"a":1}}`, `{"a" 1}`, `{"a":1 "b":2}`,
		`{"a":[1 2]}`, `{"a":{"b"}}`, `{"a":{"b":}}`, `{"a":true,"b":false,"c":null}`,
		"{\"a\":1}\n\t\r ", "{\"a\":\"\\ud800\"}", `{"a":"\/"}`, `{"a":1e400}`,
		`{"a":[1e400]}`, `{"a":{"b":-1e309}}`, `{"a":1e-400}`, `{"a":1.7976931348623157e308}`,
		`{"a":1.7976931348623159e308}`, `{"a":"1e400"}`,
		`{"a":1` + strings.Repeat("0", 308) + `}`, `{"a":1` + strings.Repeat("0", 309) + `}`,
		`{"a":2` + strings.Repeat("0", 308) + `}`,
		`{"a":-9` + strings.Repeat("9", 307) + `.5}`, `{"a":0.` + strings.Repeat("0", 400) + `1}`,
	} {
		checkScanAgrees(t, []byte(body))
	}
}

// Depth counts the outer object, as encoding/json counts it.
func TestScanStopsAtEncodingJSONsNestingLimit(t *testing.T) {
	for _, depth := range []int{maxJSONDepth - 1, maxJSONDepth, maxJSONDepth + 1} {
		inner := depth - 1
		for _, shape := range []string{"[]", "[1]"} {
			body := `{"a":` + strings.Repeat("[", inner-1) + shape + strings.Repeat("]", inner-1) + `}`
			checkScanAgrees(t, []byte(body))
		}
	}
}

func randomJSON(r *rand.Rand, depth int) string {
	space := func() string { return [...]string{"", " ", "\n", "\t", "\r", "  "}[r.Intn(6)] }
	switch pick := r.Intn(9); {
	case depth > 4 || pick < 2:
		return [...]string{`"s"`, `"é\n"`, `"\u00e9\/"`, `"\\"`, `""`, "\"\xff\""}[r.Intn(6)]
	case pick < 4:
		return [...]string{"0", "-0", "12", "-3.25", "1e10", "2E-3", "0.5e+2", "12345678901234567890",
			"1e400", "-2E+309", "1e-400"}[r.Intn(11)]
	case pick < 5:
		return [...]string{"true", "false", "null"}[r.Intn(3)]
	case pick < 7:
		items := make([]string, r.Intn(4))
		for i := range items {
			items[i] = space() + randomJSON(r, depth+1) + space()
		}
		return "[" + strings.Join(items, ",") + "]"
	default:
		return randomObject(r, depth+1)
	}
}

func randomObject(r *rand.Rand, depth int) string {
	names := [...]string{"model", "stream", "a", `mod\u0065l`, "x y", "é"}
	members := make([]string, r.Intn(4))
	for i := range members {
		members[i] = ` "` + names[r.Intn(len(names))] + `"` + [...]string{"", " "}[r.Intn(2)] + ":" +
			randomJSON(r, depth) + [...]string{"", "\n"}[r.Intn(2)]
	}
	return "{" + strings.Join(members, ",") + "}"
}

// Valid bodies and bodies one byte away from valid, from a fixed seed.
func TestScanAgreesWithEncodingJSONOnRandomBodies(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	alphabet := []byte(`"\{}[],: 01-.etnu` + "\x01\xff")
	objects := 0
	for round := 0; round < 30000; round++ {
		body := []byte(randomObject(r, 0))
		if r.Intn(2) == 0 && len(body) > 0 {
			at := r.Intn(len(body))
			c := alphabet[r.Intn(len(alphabet))]
			switch r.Intn(3) {
			case 0:
				body = append(body[:at], body[at+1:]...)
			case 1:
				body = append(body[:at], append([]byte{c}, body[at:]...)...)
			default:
				body[at] = c
			}
		}
		if isJSONObject(body) {
			objects++
		}
		checkScanAgrees(t, body)
	}
	if objects < 10000 {
		t.Fatalf("only %d of the bodies were objects", objects)
	}
}

func FuzzObjectMembers(f *testing.F) {
	for _, seed := range []string{`{}`, `{"model":"m","stream":true}`, `{"a":[1,{"b":null}]}`, `{"a":"\u00e9"}`} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, body []byte) { checkScanAgrees(t, body) })
}

// The scan allocates the member list and names, not the body.
func TestScanDoesNotCopyTheBody(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"content":"` + strings.Repeat("x", 1<<20) + `"}]}`)
	allocated := testing.AllocsPerRun(20, func() {
		if _, _, ok := objectMembers(body); !ok {
			t.Fatal("not an object")
		}
	})
	if allocated > 8 {
		t.Fatalf("objectMembers allocated %v times", allocated)
	}
}
