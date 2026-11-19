package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestCreatingAChannelReplacesAnExistingName(t *testing.T) {
	for _, status := range []struct {
		name              string
		enabled, archived bool
	}{
		{"enabled", true, false},
		{"disabled", false, false},
		{"archived-enabled", true, true},
		{"archived-disabled", false, true},
	} {
		for _, tc := range []struct {
			name    string
			payload string
		}{
			{"defaults", `{"base_url":"https://new.example.test"}`},
			{"quick-import", `{"base_url":"https://new.example.test/v1","keys":[{"name":"new","api_key":"sk-new","enabled":true}],"model_names":["new-model"],"model_prefixes":["new-"],"model_mappings":{"alias":"new-model"},"effort_mappings":{"max":"high"},"priority":999,"weight":80,"auto_weight_enabled":true,"enabled":true,"extra_headers":{"X-Region":"new"},"timeout_seconds":45,"rate_limit":"20/m","group_ids":[1]}`},
			{"disabled", `{"base_url":"https://new.example.test","keys":[],"enabled":false}`},
			{"legacy-key", `{"base_url":"https://new.example.test","api_key":"sk-legacy-new"}`},
		} {
			t.Run(status.name+"/"+tc.name, func(t *testing.T) {
				state := upstreamTestState(t)
				ctx := context.Background()
				group, err := db.CreateGroup(ctx, state.DB, &models.GroupIn{Name: "old-group"})
				if err != nil {
					t.Fatal(err)
				}
				old := models.DefaultUpstreamIn()
				old.Name, old.BaseURL = "888425", "https://old.example.test"
				keys := []models.UpstreamKeyIn{{Name: "old-a", APIKey: "sk-old-a"}, {Name: "old-b", APIKey: "sk-old-b"}}
				old.Keys = &keys
				old.ModelNames, old.ModelPrefixes = []string{"old-model"}, []string{"old-"}
				old.ModelMappings = map[string]string{"old-alias": "old-model"}
				old.EffortMappings = map[string]string{"high": "low"}
				old.Priority, old.Weight, old.AutoWeightEnabled = 12, 34, true
				old.Enabled = status.enabled
				old.ExtraHeaders = map[string]string{"Authorization": "Bearer old-secret", "X-Old": "old"}
				timeout, limit := 123.0, "2/m"
				old.TimeoutSeconds, old.RateLimit, old.GroupIDs = &timeout, &limit, []int64{group.ID}
				created, err := db.CreateUpstream(ctx, state.DB, &old)
				if err != nil {
					t.Fatal(err)
				}
				if status.archived {
					if _, err := db.SetUpstreamArchived(ctx, state.DB, created.ID, true); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := state.DB.Exec(`INSERT INTO request_logs (method, path, upstream_id, upstream_name)
				VALUES ('POST', '/v1/responses', ?, '888425')`, created.ID); err != nil {
					t.Fatal(err)
				}
				state.AutoWeight.RecordFailure(created.ID, true, state.AutoWeightPolicy())

				var payload map[string]any
				if err := json.Unmarshal([]byte(tc.payload), &payload); err != nil {
					t.Fatal(err)
				}
				save := func(name string) models.UpstreamOut {
					t.Helper()
					payload["name"] = name
					body, err := json.Marshal(payload)
					if err != nil {
						t.Fatal(err)
					}
					response := adminCall(t, http.MethodPost, "/upstreams", "/upstreams", AdminCreateUpstream(state), string(body))
					if response.Code != http.StatusCreated {
						t.Fatalf("create returned %d: %s", response.Code, response.Body.String())
					}
					var out models.UpstreamOut
					if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
						t.Fatal(err)
					}
					return out
				}
				want, got := save("reference"), save(" 888425 ")
				if got.ID != created.ID || got.Archived || got.EnabledBeforeArchive != nil {
					t.Fatalf("channel was not replaced in place: %+v", got)
				}
				actualKeys, err := db.ListUpstreamKeyValues(ctx, state.DB, got.ID)
				if err != nil {
					t.Fatal(err)
				}
				wantKeys, err := db.ListUpstreamKeyValues(ctx, state.DB, want.ID)
				if err != nil {
					t.Fatal(err)
				}
				for _, keys := range [][]models.UpstreamKey{actualKeys, wantKeys} {
					for i := range keys {
						keys[i].ID, keys[i].UpstreamID = 0, 0
					}
				}
				if !reflect.DeepEqual(actualKeys, wantKeys) {
					t.Fatalf("keys differ from a fresh channel: got %+v, want %+v", actualKeys, wantKeys)
				}
				row, found, err := db.GetUpstream(ctx, state.DB, got.ID)
				if err != nil || !found || row.Archived != 0 || row.ArchivedPrevEnabled != nil {
					t.Fatalf("stored archive: found=%v err=%v row=%+v", found, err, row)
				}
				var logID int64
				if err := state.DB.QueryRow(`SELECT upstream_id FROM request_logs WHERE upstream_name = '888425'`).Scan(&logID); err != nil || logID != created.ID {
					t.Fatalf("history was detached: id=%d err=%v", logID, err)
				}
				got.ID, want.ID = 0, 0
				got.Name, want.Name = "", ""
				got.CreatedAt, want.CreatedAt = "", ""
				got.UpdatedAt, want.UpdatedAt = "", ""
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("replacement differs from a fresh channel:\ngot  %+v\nwant %+v", got, want)
				}
			})
		}
	}
}

func TestReplacingAChannelRollsBackInvalidGroupsAndKeys(t *testing.T) {
	for _, status := range []struct {
		name     string
		archived bool
	}{
		{"active", false},
		{"archived", true},
	} {
		for _, tc := range []struct {
			name string
			body map[string]any
		}{
			{"group", map[string]any{"group_ids": []int64{99999}}},
			{"key", map[string]any{"group_ids": []int64{1}, "keys": []map[string]any{{"name": strings.Repeat("x", 101), "api_key": "sk-new"}}}},
		} {
			t.Run(status.name+"/"+tc.name, func(t *testing.T) {
				ctx := context.Background()
				state := upstreamTestState(t)
				group, err := db.CreateGroup(ctx, state.DB, &models.GroupIn{Name: "original-group"})
				if err != nil {
					t.Fatal(err)
				}
				input := models.DefaultUpstreamIn()
				input.Name, input.BaseURL = "same", "https://old.example.test"
				key := "sk-original"
				input.APIKey, input.GroupIDs = &key, []int64{group.ID}
				created, err := db.CreateUpstream(ctx, state.DB, &input)
				if err != nil {
					t.Fatal(err)
				}
				if status.archived {
					if _, err := db.SetUpstreamArchived(ctx, state.DB, created.ID, true); err != nil {
						t.Fatal(err)
					}
				}
				before, _, err := db.GetUpstream(ctx, state.DB, created.ID)
				if err != nil {
					t.Fatal(err)
				}
				beforeKeys, err := db.ListUpstreamKeyValues(ctx, state.DB, created.ID)
				if err != nil {
					t.Fatal(err)
				}
				tc.body["name"], tc.body["base_url"] = "same", "https://new.example.test"
				body, err := json.Marshal(tc.body)
				if err != nil {
					t.Fatal(err)
				}
				response := adminCall(t, http.MethodPost, "/upstreams", "/upstreams", AdminCreateUpstream(state), string(body))
				if response.Code != http.StatusBadRequest {
					t.Fatalf("invalid replacement returned %d: %s", response.Code, response.Body.String())
				}
				after, found, err := db.GetUpstream(ctx, state.DB, created.ID)
				if err != nil || !found || !reflect.DeepEqual(after, before) {
					t.Fatalf("failed replacement changed channel: found=%v err=%v\nbefore %+v\nafter %+v", found, err, before, after)
				}
				afterKeys, err := db.ListUpstreamKeyValues(ctx, state.DB, created.ID)
				if err != nil || !reflect.DeepEqual(afterKeys, beforeKeys) {
					t.Fatalf("failed replacement changed keys: err=%v before=%+v after=%+v", err, beforeKeys, afterKeys)
				}
				groups, err := db.ListUpstreamGroupIDs(ctx, state.DB, created.ID)
				if err != nil || !reflect.DeepEqual(groups, []int64{group.ID}) {
					t.Fatalf("failed replacement changed groups: %v, err=%v", groups, err)
				}
			})
		}
	}
}

func TestConcurrentCreatesOverwriteTheSameChannel(t *testing.T) {
	ctx := context.Background()
	state := upstreamTestState(t)
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL = "same", "https://old.example.test"
	created, err := db.CreateUpstream(ctx, state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetUpstreamArchived(ctx, state.DB, created.ID, true); err != nil {
		t.Fatal(err)
	}
	handler := AdminCreateUpstream(state)
	results := make(chan int, 8)
	for range cap(results) {
		go func() {
			response := adminCall(t, http.MethodPost, "/upstreams", "/upstreams", handler,
				`{"name":"same","base_url":"https://new.example.test"}`)
			results <- response.Code
		}()
	}
	var successes int
	for range cap(results) {
		switch status := <-results; status {
		case http.StatusCreated:
			successes++
		default:
			t.Errorf("concurrent create returned %d", status)
		}
	}
	if successes != cap(results) {
		t.Fatalf("%d replacements succeeded, want %d", successes, cap(results))
	}
	rows, err := db.ListUpstreams(ctx, state.DB)
	if err != nil || len(rows) != 1 || rows[0].ID != created.ID || rows[0].Archived || rows[0].BaseURL != "https://new.example.test" {
		t.Fatalf("unexpected channels after concurrent creates: %+v, err=%v", rows, err)
	}
}
