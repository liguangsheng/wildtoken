package imagestore

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// cleanupInterval is how often the size cap is enforced. Images arrive at a few
// MiB a request, so five minutes lets the directory overshoot by little.
const cleanupInterval = 5 * time.Minute

// cleanupStartupDelay keeps the first scan off the busy moment of startup.
const cleanupStartupDelay = 30 * time.Second

type storedFile struct {
	path    string
	size    int64
	modTime time.Time
}

// Enforce deletes the oldest files until the directory holds at most maxBytes.
// A cap of zero empties it. It returns how many files and bytes it removed.
func (s *Store) Enforce(maxBytes int64) (int, int64, error) {
	if s == nil || s.dir == "" {
		return 0, 0, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var files []storedFile
	var total int64
	err := filepath.WalkDir(s.dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			// A missing directory just means nothing has been saved yet.
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		files = append(files, storedFile{path: path, size: info.Size(), modTime: info.ModTime()})
		total += info.Size()
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	if total <= maxBytes {
		return 0, 0, nil
	}

	// Oldest first; the name breaks ties so the order is stable.
	sort.Slice(files, func(i, j int) bool {
		if !files[i].modTime.Equal(files[j].modTime) {
			return files[i].modTime.Before(files[j].modTime)
		}
		return files[i].path < files[j].path
	})

	removed, freed := 0, int64(0)
	for _, file := range files {
		if total <= maxBytes {
			break
		}
		if err := os.Remove(file.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("could not delete an old image", "path", file.path, "error", err)
			continue
		}
		total -= file.size
		freed += file.size
		removed++
	}

	s.removeEmptyDays()
	return removed, freed, nil
}

// removeEmptyDays drops date directories the cleanup emptied. The caller holds
// s.mu, so no save is writing into one.
func (s *Store) removeEmptyDays() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		folder := filepath.Join(s.dir, entry.Name())
		if children, err := os.ReadDir(folder); err == nil && len(children) == 0 {
			os.Remove(folder)
		}
	}
}

// RunCleanupLoop enforces the size cap until ctx ends. maxBytes is read on
// every pass, so a changed setting applies without a restart.
func RunCleanupLoop(ctx context.Context, store *Store, maxBytes func() int64) {
	if store == nil || store.dir == "" {
		return
	}

	timer := time.NewTimer(cleanupStartupDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}

		removed, freed, err := store.Enforce(maxBytes())
		switch {
		case err != nil:
			slog.Warn("image cleanup failed", "error", err)
		case removed > 0:
			slog.Info("image cleanup removed old files", "files", removed, "bytes", freed)
		}
		timer.Reset(cleanupInterval)
	}
}

// Handler serves saved images. Directory listings are refused: the random names
// are the only thing keeping one caller from another's images.
func (s *Store) Handler() http.Handler {
	files := http.FileServer(http.Dir(s.Dir()))
	return http.StripPrefix(strings.TrimSuffix(URLPrefix, "/"), http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			if s == nil || s.dir == "" || strings.HasSuffix(r.URL.Path, "/") || strings.HasSuffix(r.URL.Path, ".tmp") {
				http.NotFound(w, r)
				return
			}
			// A file never changes once written; its name is its version.
			w.Header().Set("cache-control", "public, max-age=31536000, immutable")
			w.Header().Set("x-content-type-options", "nosniff")
			files.ServeHTTP(w, r)
		}))
}
