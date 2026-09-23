package imagestore

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// A PNG header is enough for the extension sniff; the bytes after it are filler.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 64)...)
var pngBase64 = base64.StdEncoding.EncodeToString(pngBytes)

var markerPattern = regexp.MustCompile(`@image:(/images/2026-09-23/[0-9a-f]{32}\.png)`)

func testStore(t *testing.T, enabled bool) *Store {
	t.Helper()
	store := New(t.TempDir(), func() bool { return enabled })
	store.now = func() time.Time { return time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC) }
	return store
}

// savedFile resolves a marker URL back to the file it names.
func savedFile(t *testing.T, store *Store, url string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(store.dir, strings.TrimPrefix(url, URLPrefix)))
	if err != nil {
		t.Fatalf("read saved image: %v", err)
	}
	return data
}

func TestRewriteSavesJSONImagesAndLeavesTheRestAlone(t *testing.T) {
	store := testStore(t, true)
	body := []byte(`{"created":1790149989,"data":[{"b64_json":"` + pngBase64 + `","revised_prompt":"a <cat>"}]}`)

	rewritten := string(store.Rewrite(body))

	match := markerPattern.FindStringSubmatch(rewritten)
	if match == nil {
		t.Fatalf("no marker in %s", rewritten)
	}
	if !bytes.Equal(savedFile(t, store, match[1]), pngBytes) {
		t.Error("saved file differs from the decoded image")
	}
	// Numbers keep their written form and HTML stays unescaped.
	for _, want := range []string{`"created":1790149989`, `"revised_prompt":"a <cat>"`} {
		if !strings.Contains(rewritten, want) {
			t.Errorf("rewritten body lost %s: %s", want, rewritten)
		}
	}
	if strings.Contains(rewritten, pngBase64) {
		t.Error("base64 still in the body")
	}
}

func TestRewriteHandlesEveryEventOfAStream(t *testing.T) {
	store := testStore(t, true)
	body := []byte("event: image_generation.partial_image\n" +
		`data: {"type":"image_generation.partial_image","b64_json":"` + pngBase64 + `"}` + "\n\n" +
		"event: image_generation.completed\n" +
		`data: {"type":"image_generation.completed","b64_json":"` + pngBase64 + `"}` + "\n\n")

	rewritten := string(store.Rewrite(body))

	if got := len(markerPattern.FindAllString(rewritten, -1)); got != 2 {
		t.Fatalf("saved %d images, want 2:\n%s", got, rewritten)
	}
	if !strings.Contains(rewritten, "event: image_generation.completed\n") {
		t.Errorf("event lines were not preserved:\n%s", rewritten)
	}
}

func TestRewriteLeavesBodiesItCannotHandleUnchanged(t *testing.T) {
	enabled := testStore(t, true)
	for name, body := range map[string]string{
		"not an image":   `{"choices":[{"message":{"content":"hi"}}]}`,
		"truncated JSON": `{"data":[{"b64_json":"` + pngBase64[:20],
		"bad base64":     `{"data":[{"b64_json":"%%%not base64%%%"}]}`,
	} {
		if got := string(enabled.Rewrite([]byte(body))); got != body {
			t.Errorf("%s: body changed to %s", name, got)
		}
	}

	disabled := testStore(t, false)
	body := `{"data":[{"b64_json":"` + pngBase64 + `"}]}`
	if got := string(disabled.Rewrite([]byte(body))); got != body {
		t.Error("a disabled store rewrote the body")
	}
	if entries, _ := os.ReadDir(disabled.dir); len(entries) != 0 {
		t.Error("a disabled store wrote files")
	}

	var none *Store
	if got := string(none.Rewrite([]byte(body))); got != body {
		t.Error("a nil store rewrote the body")
	}
}

func writeAged(t *testing.T, path string, size int, age time.Duration) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-age)
	os.Chtimes(path, stamp, stamp)
}

func TestEnforceDeletesOldestFirstAndDropsEmptyDays(t *testing.T) {
	store := testStore(t, true)
	oldest := filepath.Join(store.dir, "2026-09-01", "a.png")
	middle := filepath.Join(store.dir, "2026-09-02", "b.png")
	newest := filepath.Join(store.dir, "2026-09-03", "c.png")
	writeAged(t, oldest, 100, 3*time.Hour)
	writeAged(t, middle, 100, 2*time.Hour)
	writeAged(t, newest, 100, time.Hour)

	removed, freed, err := store.Enforce(150)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 || freed != 200 {
		t.Errorf("removed %d files / %d bytes, want 2 / 200", removed, freed)
	}
	if _, err := os.Stat(newest); err != nil {
		t.Error("the newest image was deleted")
	}
	if _, err := os.Stat(filepath.Dir(oldest)); !os.IsNotExist(err) {
		t.Error("an emptied date directory was left behind")
	}

	// A cap of zero empties the directory.
	if removed, _, _ := store.Enforce(0); removed != 1 {
		t.Errorf("cap 0 removed %d files, want 1", removed)
	}
}

func TestEnforceOnAMissingDirectoryIsANoOp(t *testing.T) {
	store := New(filepath.Join(t.TempDir(), "never-created"), func() bool { return true })
	if _, _, err := store.Enforce(0); err != nil {
		t.Errorf("missing directory: %v", err)
	}
}

func TestHandlerServesImagesButNoListingsOrPartialFiles(t *testing.T) {
	store := testStore(t, true)
	url := markerPattern.FindStringSubmatch(string(store.Rewrite(
		[]byte(`{"data":[{"b64_json":"` + pngBase64 + `"}]}`))))[1]
	writeAged(t, filepath.Join(store.dir, "2026-09-23", "half.png.tmp"), 10, 0)

	serve := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		store.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder
	}

	image := serve(url)
	if image.Code != http.StatusOK || !bytes.Equal(image.Body.Bytes(), pngBytes) {
		t.Fatalf("image: status %d", image.Code)
	}
	if image.Header().Get("content-type") != "image/png" {
		t.Errorf("content-type %q", image.Header().Get("content-type"))
	}

	for _, path := range []string{"/images/", "/images/2026-09-23/", "/images/2026-09-23/half.png.tmp"} {
		if code := serve(path).Code; code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, code)
		}
	}
}
