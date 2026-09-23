// Package imagestore saves generated images as files so request logs can keep a
// path instead of the base64.
//
// An image generation response carries each picture as a base64 string, often
// 1–2 MiB. Kept in the log body it runs past the body cap and is cut in half,
// and the body cleanup clears it within a few hundred requests. Moved to a file,
// the log stays small and the picture survives until the directory's own size
// cap evicts it.
//
// Files are named with 128 random bits and served without authentication: the
// console's <img> tags cannot send the admin header, and a name nobody can guess
// is the access check.
package imagestore

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Marker replaces a saved image's base64 in the logged body, followed by the
// URL it is served at: "b64_json": "@image:/images/2026-09-23/3f9c….png".
const Marker = "@image:"

// URLPrefix is where the router mounts Handler.
const URLPrefix = "/images/"

// MaxCaptureBytes bounds how much of a streamed image response the proxy keeps
// for extraction. Four 4K PNGs fit; past that the tail is logged truncated as
// before.
const MaxCaptureBytes = 64 << 20

// Store writes images under dir. A nil *Store is valid and does nothing, so
// callers need no checks when storage is not configured.
type Store struct {
	dir string
	// enabled is read on every call: the runtime setting can turn saving off
	// without a restart.
	enabled func() bool
	now     func() time.Time
	// mu keeps Enforce from deleting a date directory a concurrent save is
	// about to write into.
	mu sync.Mutex
}

// New returns a store rooted at dir. enabled reports whether saving is on.
func New(dir string, enabled func() bool) *Store {
	return &Store{dir: dir, enabled: enabled, now: time.Now}
}

// Dir is the directory files are written to.
func (s *Store) Dir() string {
	if s == nil {
		return ""
	}
	return s.dir
}

// Enabled reports whether new images are being saved.
func (s *Store) Enabled() bool {
	return s != nil && s.dir != "" && s.enabled()
}

// Rewrite saves every "b64_json" image in a response body and returns the body
// with each replaced by Marker and its URL. It handles a plain JSON body and an
// SSE stream of JSON events.
//
// Anything it cannot handle comes back unchanged: a body that is not JSON, one
// that was truncated, an image that fails to decode or write. Losing the file
// must never lose the log.
func (s *Store) Rewrite(body []byte) []byte {
	if !s.Enabled() || !bytes.Contains(body, []byte(`"b64_json"`)) {
		return body
	}

	trimmed := bytes.TrimSpace(body)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		if rewritten, ok := s.rewriteJSON(trimmed); ok {
			return rewritten
		}
		return body
	}
	return s.rewriteSSE(body)
}

// rewriteSSE rewrites each "data:" line on its own; other lines pass through.
func (s *Store) rewriteSSE(body []byte) []byte {
	lines := bytes.Split(body, []byte("\n"))
	changed := false
	for index, line := range lines {
		payload, found := bytes.CutPrefix(bytes.TrimRight(line, "\r"), []byte("data:"))
		if !found || !bytes.Contains(payload, []byte(`"b64_json"`)) {
			continue
		}
		rewritten, ok := s.rewriteJSON(bytes.TrimSpace(payload))
		if !ok {
			continue
		}
		lines[index] = append([]byte("data: "), rewritten...)
		changed = true
	}
	if !changed {
		return body
	}
	return bytes.Join(lines, []byte("\n"))
}

// rewriteJSON decodes one JSON document, swaps its images for markers and
// encodes it again. ok is false when nothing was saved.
func (s *Store) rewriteJSON(document []byte) ([]byte, bool) {
	decoder := json.NewDecoder(bytes.NewReader(document))
	// Numbers stay as written; float64 would round large ids and timestamps.
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, false
	}

	saved := 0
	s.walk(value, &saved)
	if saved == 0 {
		return nil, false
	}

	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	// A revised prompt with "<" in it should read as written in the log.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, false
	}
	return bytes.TrimRight(out.Bytes(), "\n"), true
}

func (s *Store) walk(value any, saved *int) {
	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			if encoded, ok := child.(string); ok && key == "b64_json" && encoded != "" &&
				!strings.HasPrefix(encoded, Marker) {
				if url, err := s.save(encoded); err == nil {
					node[key] = Marker + url
					*saved++
				} else {
					slog.Warn("could not save a generated image; the log keeps its base64", "error", err)
				}
				continue
			}
			s.walk(child, saved)
		}
	case []any:
		for _, child := range node {
			s.walk(child, saved)
		}
	}
}

// save decodes one image and writes it to dir/<date>/<random>.<ext>, returning
// the URL it is served at.
func (s *Store) save(encoded string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}

	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	day := s.now().Format(time.DateOnly)
	name := hex.EncodeToString(random[:]) + "." + extension(data)

	s.mu.Lock()
	defer s.mu.Unlock()

	folder := filepath.Join(s.dir, day)
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return "", err
	}
	// Written under a temporary name and renamed, so the file server never
	// hands out half an image and a crash leaves no truncated file behind
	// under a real name.
	final := filepath.Join(folder, name)
	temporary := final + ".tmp"
	if err := os.WriteFile(temporary, data, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(temporary, final); err != nil {
		os.Remove(temporary)
		return "", err
	}
	return URLPrefix + day + "/" + name, nil
}

// extension names the file after its content. Only raster formats are ever
// written, so nothing served from here can carry script the way an SVG could.
func extension(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(data, []byte("\xff\xd8\xff")):
		return "jpg"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "webp"
	case bytes.HasPrefix(data, []byte("GIF8")):
		return "gif"
	default:
		return "bin"
	}
}
