// Command wildtoken runs the WildToken gateway.
//
// CLI builds on Linux and macOS run in the foreground. The macOS desktop
// build runs from an application bundle; Windows defaults to a system tray.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"

	"github.com/liguangsheng/wildtoken/internal/app"
)

// defaultGCPercent halves Go's default heap headroom. The gateway's garbage is
// mostly request and response bodies; at 100 the heap held about twice the
// live bodies, so 8 concurrent 22 MiB uploads peaked at 714 MiB, at 50 at
// 471 MiB, for the same CPU. 100 concurrent small streams pay about a tenth
// more GC CPU for a fifth less memory. GOGC in the environment still wins.
const defaultGCPercent = 50

func main() {
	if _, set := os.LookupEnv("GOGC"); !set {
		debug.SetGCPercent(defaultGCPercent)
	}
	if handled, code := desktopMain(); handled {
		os.Exit(code)
	}
	// `wildtoken backup` takes one backup beside a running server and exits.
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		os.Exit(runBackup())
	}
	if runTray() {
		return
	}
	os.Exit(runServer(false))
}

func runBackup() int {
	initLogging(false)
	path, err := app.BackupNow(context.Background())
	if err != nil {
		slog.Error("backup failed", "error", err)
		return 1
	}
	slog.Info("backup written", "path", path)
	return 0
}

// runServer starts the gateway and blocks until it stops. It returns the
// process exit code.
func runServer(logToFile bool) int {
	initLogging(logToFile)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	server, err := app.New(ctx)
	if err != nil {
		slog.Error("WildToken failed to start", "error", err)
		return 1
	}

	if err := server.Serve(ctx); err != nil {
		slog.Error("WildToken exited with error", "error", err)
		return 1
	}
	return 0
}

// initLogging sends output to stdout, or to wildtoken.log when no console is
// attached.
func initLogging(logToFile bool) {
	level := slog.LevelInfo
	if value := os.Getenv("WILDTOKEN_LOG"); value != "" {
		if err := level.UnmarshalText([]byte(value)); err != nil {
			level = slog.LevelInfo
		}
	}
	options := &slog.HandlerOptions{Level: level}

	if !logToFile {
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, options)))
		return
	}

	file, err := os.OpenFile("wildtoken.log", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		// Fall back to stdout, which may be discarded without a console.
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, options)))
		slog.Error("failed to open wildtoken.log; falling back to stdout", "error", err)
		return
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(file, options)))
}
