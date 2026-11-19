package ctl

import "github.com/liguangsheng/wildtoken/internal/client"

type Command struct {
	Name    string      `json:"command"`
	Method  string      `json:"method"`
	Path    string      `json:"path"`
	Auth    client.Auth `json:"auth"`
	Mutates bool        `json:"requires_confirmation"`
	Stream  bool        `json:"stream,omitempty"`
	Input   bool        `json:"input_required,omitempty"`
	body    string
}

func command(name, method, path string, input bool) Command {
	return Command{Name: name, Method: method, Path: "/api/admin" + path,
		Auth: client.Admin, Mutates: method != "GET", Input: input}
}

func fixed(name, method, path, body string) Command {
	c := command(name, method, path, false)
	c.body = body
	return c
}

func readPost(name, path string) Command {
	c := command(name, "POST", path, false)
	c.Mutates = false
	return c
}

func streamCommand(name, method, path string, input bool) Command {
	c := command(name, method, path, input)
	c.Stream = true
	return c
}

var commands = []Command{
	{Name: "health", Method: "GET", Path: "/health", Auth: client.Public},
	{Name: "active", Method: "GET", Path: "/health/active", Auth: client.Public},
	{Name: "themes", Method: "GET", Path: "/api/themes", Auth: client.Public},
	{Name: "models list", Method: "GET", Path: "/v1/models", Auth: client.Downstream},
	streamCommand("debug", "POST", "/debug", true),
	command("status", "GET", "/system", false),
	command("metrics", "GET", "/system/metrics", false),
	command("settings get", "GET", "/settings/", false),
	command("settings update", "PUT", "/settings/", true),
	command("settings rotate-admin-token", "POST", "/settings/admin-token/rotate", true),
	command("prompts list", "GET", "/settings/model-test-prompts", false),
	command("prompts create", "POST", "/settings/model-test-prompts", true),
	command("prompts update", "PATCH", "/settings/model-test-prompts/{id}", true),
	command("prompts delete", "DELETE", "/settings/model-test-prompts/{id}", false),
	command("upstreams list", "GET", "/upstreams/", false),
	command("upstreams get", "GET", "/upstreams/{id}", false),
	command("upstreams create", "POST", "/upstreams/", true),
	command("upstreams update", "PUT", "/upstreams/{id}", true),
	command("upstreams delete", "DELETE", "/upstreams/{id}", false),
	fixed("upstreams enable", "PATCH", "/upstreams/{id}/enabled", `{"enabled":true}`),
	fixed("upstreams disable", "PATCH", "/upstreams/{id}/enabled", `{"enabled":false}`),
	fixed("upstreams archive", "PATCH", "/upstreams/{id}/archived", `{"archived":true}`),
	fixed("upstreams restore", "PATCH", "/upstreams/{id}/archived", `{"archived":false}`),
	command("upstreams priority", "PATCH", "/upstreams/{id}/priority", true),
	command("upstreams credential", "GET", "/upstreams/{id}/credential", false),
	command("upstreams test", "POST", "/upstreams/{id}/test", false),
	command("upstreams test-model", "POST", "/upstreams/{id}/test-model", true),
	streamCommand("upstreams debug", "POST", "/upstreams/{id}/debug", true),
	command("upstreams models", "POST", "/upstreams/{id}/models", false),
	command("upstreams balance", "POST", "/upstreams/{id}/balance", false),
	command("upstreams balance-sub2api", "POST", "/upstreams/{id}/balance/sub2api", false),
	command("upstreams fetch-models", "POST", "/upstreams/fetch-models", true),
	readPost("upstreams export", "/upstreams/export"),
	command("upstreams import", "POST", "/upstreams/import", true),
	command("upstreams stats", "GET", "/upstreams/stats", false),
	command("upstreams health", "GET", "/upstreams/health", false),
	command("groups list", "GET", "/groups/", false),
	command("groups get", "GET", "/groups/{id}", false),
	command("groups create", "POST", "/groups/", true),
	command("groups update", "PUT", "/groups/{id}", true),
	command("groups delete", "DELETE", "/groups/{id}", false),
	command("tokens list", "GET", "/tokens/", false),
	command("tokens get", "GET", "/tokens/{id}", false),
	command("tokens create", "POST", "/tokens/", true),
	command("tokens update", "PUT", "/tokens/{id}", true),
	command("tokens delete", "DELETE", "/tokens/{id}", false),
	fixed("tokens enable", "PATCH", "/tokens/{id}/enabled", `{"enabled":true}`),
	fixed("tokens disable", "PATCH", "/tokens/{id}/enabled", `{"enabled":false}`),
	command("tokens reset-usage", "POST", "/tokens/{id}/usage/reset", false),
	command("logs list", "GET", "/logs/", false),
	command("logs get", "GET", "/logs/{id}", false),
	streamCommand("logs stream", "GET", "/logs/stream", false),
	command("logs attempts", "GET", "/logs/{id}/attempts", false),
	command("logs snapshot", "GET", "/logs/{id}/snapshots/{field}", false),
	command("logs token-usage", "GET", "/logs/token-usage", false),
	command("logs top", "GET", "/logs/top", false),
	command("logs overview", "GET", "/logs/overview", false),
	command("logs daily", "GET", "/logs/daily", false),
	command("logs clients", "GET", "/logs/clients", false),
}
