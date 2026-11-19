package ctl

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCLIRoutedDebugRequiresConfirmationAndReportsFailure(t *testing.T) {
	testAuth(t)
	for _, status := range []int{200, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var hits atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.URL.Path != "/api/admin/debug" || r.Header.Get("x-admin-token") != "unit-admin-key" || r.Header.Get("Authorization") != "" {
					t.Error("wrong route or authentication")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "event: response\ndata: {\"status_code\":%d}\n\nevent: done\ndata: {\"elapsed_ms\":1}\n\n", status)
			}))
			defer server.Close()
			args := []string{"debug", "--data", `{"protocol":"responses","group_id":1,"body":{"model":"m","input":"hi"}}`}
			if code, _, _ := invoke(t, server.URL, args...); code == 0 {
				t.Fatal("billable request required no confirmation")
			}
			if code, _, err := invoke(t, server.URL, append(args, "--dry-run")...); code != 0 {
				t.Fatal(err)
			}
			if hits.Load() != 0 {
				t.Fatal("preview contacted the server")
			}
			code, out, err := invoke(t, server.URL, append(args, "--yes")...)
			if (code == 0) != (status == 200) || !strings.Contains(out, "response") {
				t.Fatalf("status=%d exit=%d out=%s error=%s", status, code, out, err)
			}
			if hits.Load() != 1 {
				t.Fatal("unexpected request count")
			}
		})
	}
}
