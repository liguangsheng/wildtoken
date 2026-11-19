package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// adminCall runs one admin handler behind a router that resolves {id}.
func adminCall(t *testing.T, method, pattern, path string, handler http.HandlerFunc,
	body string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	router.Method(method, pattern, handler)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(method, path, strings.NewReader(body)))
	return recorder
}

// A document that leaves fields out gets the defaults a created channel gets,
// not zero values: weight 0, priority 0, disabled, and null model lists the
// console could not render.
func TestImportFillsWhatTheDocumentLeavesOut(t *testing.T) {
	state := upstreamTestState(t)
	response := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"skip","channels":[{"name":"partial","base_url":"https://api.example.com"}]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("import returned %d: %s", response.Code, response.Body.String())
	}

	row, found, err := db.GetUpstreamByName(context.Background(), state.DB, "partial")
	if err != nil || !found {
		t.Fatalf("imported channel: found=%v err=%v", found, err)
	}
	if row.Weight != 100 || row.Priority != 100 || row.Enabled != 1 || row.AutoWeightEnabled != 0 {
		t.Errorf("weight=%d priority=%d enabled=%d auto=%d, want the create defaults",
			row.Weight, row.Priority, row.Enabled, row.AutoWeightEnabled)
	}
	if row.ModelNames != "[]" || row.ModelPrefixes != "[]" || row.EffortMappings != "{}" {
		t.Errorf("collections stored as %s / %s / %s, want empty ones",
			row.ModelNames, row.ModelPrefixes, row.EffortMappings)
	}
	// 0 follows the service default, including later changes to it.
	if row.TimeoutSeconds != 0 {
		t.Errorf("timeout = %v, want 0 for the service default", row.TimeoutSeconds)
	}
}

// The name is stored trimmed, so it is looked up trimmed: " foo " missed an
// existing "foo" and then collided with it on insert.
func TestImportFindsAnExistingChannelByItsTrimmedName(t *testing.T) {
	state := upstreamTestState(t)
	createChannel(t, state, "foo", "https://api.example.com", 100, nil)

	response := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"skip","channels":[{"name":" foo ","base_url":"https://api.example.com"}]}`)
	var result models.ImportUpstreamsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Skipped != 1 || result.Failed != 0 {
		t.Errorf("result = %+v, want the padded name skipped as the existing channel", result)
	}
}

// A key moved into a header is still a key. An export without keys leaves such
// headers out, and importing it over a channel keeps the channel's own, as it
// keeps its API key.
func TestAnExportWithoutKeysLeavesCredentialHeadersOut(t *testing.T) {
	state := upstreamTestState(t)
	input := models.DefaultUpstreamIn()
	input.Name = "secretive"
	input.BaseURL = "https://api.example.com"
	input.ExtraHeaders = map[string]string{"X-Api-Key": "header-secret", "X-Region": "eu"}
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input); err != nil {
		t.Fatal(err)
	}

	exported := adminCall(t, http.MethodPost, "/export", "/export", AdminExportUpstreams(state),
		`{"include_api_keys":false}`)
	if exported.Code != http.StatusOK {
		t.Fatalf("export returned %d: %s", exported.Code, exported.Body.String())
	}
	if strings.Contains(exported.Body.String(), "header-secret") {
		t.Fatalf("an export without keys carries a credential header: %s", exported.Body.String())
	}
	if !strings.Contains(exported.Body.String(), `"X-Region":"eu"`) {
		t.Errorf("an ordinary header was dropped too: %s", exported.Body.String())
	}

	var document struct {
		Channels json.RawMessage `json:"channels"`
	}
	if err := json.Unmarshal(exported.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	imported := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"overwrite","channels":`+string(document.Channels)+`}`)
	if imported.Code != http.StatusOK {
		t.Fatalf("import returned %d: %s", imported.Code, imported.Body.String())
	}

	row, _, err := db.GetUpstreamByName(context.Background(), state.DB, "secretive")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(row.ExtraHeaders, "header-secret") {
		t.Errorf("overwriting from the keyless export removed the credential header: %s",
			row.ExtraHeaders)
	}
}

// A rename onto a taken name conflicts with another channel.
func TestRenamingOntoATakenNameIsABadRequest(t *testing.T) {
	state := upstreamTestState(t)
	createChannel(t, state, "first", "https://api.example.com", 100, nil)
	createChannel(t, state, "second", "https://api.example.com", 100, nil)
	second, _, err := db.GetUpstreamByName(context.Background(), state.DB, "second")
	if err != nil {
		t.Fatal(err)
	}

	path := "/api/admin/upstreams/" + strconv.FormatInt(second.ID, 10)
	response := adminCall(t, http.MethodPut, "/api/admin/upstreams/{id}", path,
		AdminUpdateUpstream(state), updateBody(t, fullUpdate("first"), ""))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "already exists") {
		t.Errorf("rename onto a taken name returned %d, want 400: %s",
			response.Code, response.Body.String())
	}
}

// fullUpdate is a complete replacing update, as the console sends one.
func fullUpdate(name string) map[string]any {
	return map[string]any{
		"name": name, "base_url": "https://api.example.com",
		"model_names": []string{}, "model_prefixes": []string{},
		"model_mappings": map[string]string{}, "effort_mappings": map[string]string{},
		"priority": 100, "weight": 100, "auto_weight_enabled": true, "enabled": true,
		"extra_headers": map[string]string{}, "rate_limit": nil, "group_ids": []int64{},
	}
}

// updateBody encodes an update without the named field.
func updateBody(t *testing.T, fields map[string]any, without string) string {
	t.Helper()
	delete(fields, without)
	encoded, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// A PUT replaces the channel. A field it leaves out is refused, not defaulted:
// a missing enabled switched a disabled channel back on.
func TestAnUpdateMissingAFieldIsRefused(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()
	input := models.DefaultUpstreamIn()
	input.Name = "off"
	input.BaseURL = "https://api.example.com"
	input.Enabled = false
	created, err := db.CreateUpstream(ctx, state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}

	path := "/api/admin/upstreams/" + strconv.FormatInt(created.ID, 10)
	response := adminCall(t, http.MethodPut, "/api/admin/upstreams/{id}", path,
		AdminUpdateUpstream(state), updateBody(t, fullUpdate("off"), "enabled"))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "enabled") {
		t.Fatalf("returned %d, want 400 naming enabled: %s", response.Code, response.Body.String())
	}
	row, _, err := db.GetUpstream(ctx, state.DB, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Enabled != 0 {
		t.Error("the refused update switched the channel on")
	}

	// Those with a meaning when absent may still be left out: fullUpdate has no
	// api_key, timeout_seconds or clear_api_key.
	fields := fullUpdate("off")
	fields["enabled"] = false
	response = adminCall(t, http.MethodPut, "/api/admin/upstreams/{id}", path,
		AdminUpdateUpstream(state), updateBody(t, fields, ""))
	if response.Code != http.StatusOK {
		t.Errorf("an update without api_key or timeout returned %d: %s",
			response.Code, response.Body.String())
	}
}

// The probe sends the key the way the proxy would for the same protocol. As a
// Bearer token it failed a native Anthropic channel that served traffic fine.
func TestAMessagesModelTestSendsTheKeyAsXAPIKey(t *testing.T) {
	state := proxyRateLimitState(t)
	received := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":"hi"}]}`))
	}))
	defer server.Close()

	key := "channel-key"
	input := models.DefaultUpstreamIn()
	input.Name = "anthropic"
	input.BaseURL = server.URL
	input.APIKey = &key
	created, err := db.CreateUpstream(context.Background(), state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}

	path := "/api/admin/upstreams/" + strconv.FormatInt(created.ID, 10) + "/test-model"
	response := adminCall(t, http.MethodPost, "/api/admin/upstreams/{id}/test-model", path,
		AdminTestUpstreamModel(state),
		`{"model":"claude","protocol":"messages","prompt_template_id":0,"prompt":"hi"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("model test returned %d: %s", response.Code, response.Body.String())
	}

	headers := <-received
	if headers.Get("x-api-key") != key || headers.Get("authorization") != "" {
		t.Errorf("probe sent x-api-key=%q authorization=%q, want the key as x-api-key only",
			headers.Get("x-api-key"), headers.Get("authorization"))
	}
}

// A stored zero means "the service default" to the proxy; the probes read it the
// same way instead of as a one-second budget.
func TestAChannelWithoutItsOwnTimeoutIsProbedWithTheDefault(t *testing.T) {
	state := upstreamTestState(t)
	want := time.Duration(state.EffectiveUpstreamTimeoutSeconds() * float64(time.Second))
	if got := probeTimeout(state, 0); got != want {
		t.Errorf("probe timeout for 0 = %v, want the default %v", got, want)
	}
	if got := probeTimeout(state, 12); got != 12*time.Second {
		t.Errorf("probe timeout for 12 = %v, want 12s", got)
	}
}

// The preview dials with the timeout the form holds, bounded like a saved one:
// a huge value overflowed the Duration and timed out at once.
func TestThePreviewRefusesAnOutOfRangeTimeout(t *testing.T) {
	state := upstreamTestState(t)
	response := adminCall(t, http.MethodPost, "/fetch-models", "/fetch-models",
		AdminFetchModelsPreview(state),
		`{"base_url":"https://api.example.com","timeout_seconds":1e12}`)
	if response.Code != http.StatusBadRequest {
		t.Errorf("returned %d, want 400: %s", response.Code, response.Body.String())
	}
}

// Groups travel by name. The ids number the groups of the instance the export
// came from; bound by id, a channel landed in whichever group held that number
// here, or failed when none did.
func TestAnImportBindsGroupsByName(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()
	other, err := db.CreateGroup(ctx, state.DB, &models.GroupIn{Name: "other"})
	if err != nil {
		t.Fatal(err)
	}

	id := strconv.FormatInt(other.ID, 10)
	response := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"skip","channels":[
            {"name":"vip-channel","base_url":"https://x","group_ids":[`+id+`],"group_names":["vip"]},
            {"name":"other-channel","base_url":"https://x","group_ids":[99],"group_names":["other"]}]}`)
	var result models.ImportUpstreamsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Created != 2 {
		t.Fatalf("import: %s", response.Body.String())
	}

	groups, err := db.ListGroups(ctx, state.DB)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]int64{}
	for _, group := range groups {
		byName[group.Name] = group.ID
	}
	for channel, want := range map[string]int64{"vip-channel": byName["vip"], "other-channel": other.ID} {
		row, _, err := db.GetUpstreamByName(ctx, state.DB, channel)
		if err != nil {
			t.Fatal(err)
		}
		ids, err := db.ListUpstreamGroupIDs(ctx, state.DB, row.ID)
		if err != nil {
			t.Fatal(err)
		}
		if want == 0 || len(ids) != 1 || ids[0] != want {
			t.Errorf("%s serves %v, want [%d]", channel, ids, want)
		}
	}
}

// An export records group names and the archive; without the archive, an
// archived channel came back as a disabled one.
func TestAnExportCarriesGroupNamesAndTheArchive(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()
	vip, err := db.CreateGroup(ctx, state.DB, &models.GroupIn{Name: "vip"})
	if err != nil {
		t.Fatal(err)
	}
	input := models.DefaultUpstreamIn()
	input.Name = "parked"
	input.BaseURL = "https://x"
	input.GroupIDs = []int64{vip.ID}
	created, err := db.CreateUpstream(ctx, state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetUpstreamArchived(ctx, state.DB, created.ID, true); err != nil {
		t.Fatal(err)
	}

	response := adminCall(t, http.MethodPost, "/export", "/export", AdminExportUpstreams(state), `{}`)
	var document models.ExportUpstreamsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil || len(document.Channels) != 1 {
		t.Fatalf("export: %s", response.Body.String())
	}
	item := document.Channels[0]
	if len(item.GroupNames) != 1 || item.GroupNames[0] != "vip" {
		t.Errorf("group_names = %v, want [vip]", item.GroupNames)
	}
	if item.Archived == nil || !*item.Archived {
		t.Errorf("archived = %v, want true", item.Archived)
	}
}

// The archive is applied with the write. A document that says nothing about
// it leaves an archived channel archived, and off even if it says enabled.
func TestAnImportRestoresTheArchive(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()
	importOne := func(mode, channel string) {
		t.Helper()
		response := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
			`{"mode":"`+mode+`","channels":[`+channel+`]}`)
		var result models.ImportUpstreamsResponse
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Failed != 0 {
			t.Fatalf("import %s: %s", channel, response.Body.String())
		}
	}
	stored := func() (archived, enabled int64) {
		t.Helper()
		row, _, err := db.GetUpstreamByName(ctx, state.DB, "c")
		if err != nil {
			t.Fatal(err)
		}
		return row.Archived, row.Enabled
	}

	importOne("skip", `{"name":"c","base_url":"https://x","enabled":false,"archived":true}`)
	if archived, enabled := stored(); archived != 1 || enabled != 0 {
		t.Errorf("created: archived=%d enabled=%d, want 1 0", archived, enabled)
	}

	importOne("overwrite", `{"name":"c","base_url":"https://x","enabled":true}`)
	if archived, enabled := stored(); archived != 1 || enabled != 0 {
		t.Errorf("no archived field: archived=%d enabled=%d, want 1 0", archived, enabled)
	}

	importOne("overwrite", `{"name":"c","base_url":"https://x","enabled":true,"archived":false}`)
	if archived, enabled := stored(); archived != 0 || enabled != 1 {
		t.Errorf("archived false: archived=%d enabled=%d, want 0 1", archived, enabled)
	}
}

// Saving an Accept-Encoding override is refused; the gateway must read
// responses uncompressed.
func TestAnAcceptEncodingOverrideIsRefusedWhenSaved(t *testing.T) {
	if err := validateOverrides(map[string]string{"Accept-Encoding": "gzip"}); err == nil {
		t.Error("an Accept-Encoding override was accepted")
	}
	if err := validateOverrides(map[string]string{"X-Region": "eu"}); err != nil {
		t.Errorf("an ordinary override was refused: %v", err)
	}
}

// A document that names no group keeps an overwritten channel's groups rather
// than moving it to the default group alone.
func TestAnImportWithoutGroupsKeepsTheChannelsGroups(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()
	vip, err := db.CreateGroup(ctx, state.DB, &models.GroupIn{Name: "vip"})
	if err != nil {
		t.Fatal(err)
	}
	input := models.DefaultUpstreamIn()
	input.Name = "c"
	input.BaseURL = "https://x"
	input.GroupIDs = []int64{vip.ID}
	created, err := db.CreateUpstream(ctx, state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}

	adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"overwrite","channels":[{"name":"c","base_url":"https://y"}]}`)
	ids, err := db.ListUpstreamGroupIDs(ctx, state.DB, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != vip.ID {
		t.Errorf("groups = %v, want [%d] kept", ids, vip.ID)
	}
}

// An archived channel keeps, through export and import, the state unarchiving
// restores: enabled is always false while archived, so without it the
// channel came back disabled.
func TestAnArchivedChannelComesBackAsItWasBeforeTheArchive(t *testing.T) {
	source := upstreamTestState(t)
	ctx := context.Background()
	input := models.DefaultUpstreamIn()
	input.Name = "parked"
	input.BaseURL = "https://x"
	created, err := db.CreateUpstream(ctx, source.DB, &input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetUpstreamArchived(ctx, source.DB, created.ID, true); err != nil {
		t.Fatal(err)
	}
	exported := adminCall(t, http.MethodPost, "/export", "/export", AdminExportUpstreams(source), `{}`)
	if !strings.Contains(exported.Body.String(), `"enabled_before_archive":true`) {
		t.Fatalf("export lacks the state before the archive: %s", exported.Body.String())
	}

	var document struct {
		Channels json.RawMessage `json:"channels"`
	}
	json.Unmarshal(exported.Body.Bytes(), &document)
	if _, err := source.DB.Exec(`DELETE FROM upstreams`); err != nil {
		t.Fatal(err)
	}
	adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(source),
		`{"mode":"skip","channels":`+string(document.Channels)+`}`)

	row, _, err := db.GetUpstreamByName(ctx, source.DB, "parked")
	if err != nil || row.Archived != 1 || row.Enabled != 0 {
		t.Fatalf("imported archived=%d enabled=%d err=%v, want archived and off", row.Archived, row.Enabled, err)
	}
	restored, err := db.SetUpstreamArchived(ctx, source.DB, row.ID, false)
	if err != nil || !restored.Enabled {
		t.Errorf("unarchived enabled=%v err=%v, want it back on", restored.Enabled, err)
	}
}

// The enable switch is refused on an archived channel. Written through, it
// left the channel archived and enabled at once.
func TestAnArchivedChannelCannotBeSwitched(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()
	input := models.DefaultUpstreamIn()
	input.Name = "parked"
	input.BaseURL = "https://x"
	created, err := db.CreateUpstream(ctx, state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetUpstreamArchived(ctx, state.DB, created.ID, true); err != nil {
		t.Fatal(err)
	}

	path := "/api/admin/upstreams/" + strconv.FormatInt(created.ID, 10) + "/enabled"
	response := adminCall(t, http.MethodPatch, "/api/admin/upstreams/{id}/enabled", path,
		AdminSetUpstreamEnabled(state), `{"enabled":true}`)
	if response.Code != http.StatusBadRequest {
		t.Errorf("returned %d, want 400", response.Code)
	}
}
