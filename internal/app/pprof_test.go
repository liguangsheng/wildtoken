package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/imagestore"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestAdminPprofIndexListsProfiles(t *testing.T) {
	const token = "pprof-test-admin-token-long-enough-for-auth"
	hash, err := authstate.HashAdminToken(token)
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := authstate.NewCredentials(models.AdminCredential{
		CredentialHash:    hash,
		CredentialVersion: 1,
	}, authstate.NewThrottle())
	if err != nil {
		t.Fatal(err)
	}

	router := NewRouter(&appstate.State{
		Settings:    config.Default(),
		Credentials: credentials,
		Images:      imagestore.New(t.TempDir(), func() bool { return true }),
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/admin/debug/pprof/", nil)
	request.Header.Set("x-admin-token", token)
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "heap") {
		t.Fatal("pprof index does not list the heap profile")
	}
}

func TestAdminPprofRequiresAdminToken(t *testing.T) {
	router := NewRouter(&appstate.State{
		Settings: config.Default(),
		Images:   imagestore.New(t.TempDir(), func() bool { return true }),
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/admin/debug/pprof/", nil)
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnauthorized)
	}
}
