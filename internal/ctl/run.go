// Package ctl implements the wildtokenctl command line.
package ctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/client"
)

// Version is injected by release builds.
var Version = "dev"

func Run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	o, positional, err := parse(args, io.Discard)
	if err == nil {
		err = run(ctx, o, positional, stdin, stdout)
	}
	if err == nil {
		return 0
	}
	if errors.Is(err, context.Canceled) {
		return 130
	}
	result := map[string]any{"error": err.Error()}
	code := 1
	var response *client.HTTPError
	if errors.As(err, &response) {
		code = 4
		if response.Status == 401 || response.Status == 403 {
			code = 3
		}
		result["http_status"] = response.Status
		value, _ := jsonValue(response.Body)
		result["details"] = redact(value, false)
	}
	json.NewEncoder(stderr).Encode(result)
	return code
}

func run(ctx context.Context, o options, args []string, stdin io.Reader, stdout io.Writer) error {
	if o.version {
		return output(stdout, map[string]string{"version": clientVersion()}, o)
	}
	if o.help || len(args) == 0 || args[0] == "help" {
		return help(stdout)
	}
	if args[0] == "version" {
		return output(stdout, map[string]string{"version": clientVersion()}, o)
	}
	if args[0] == "commands" {
		return output(stdout, commands, o)
	}
	if err := checkOutputs(o); err != nil {
		return err
	}
	if args[0] == "skill" {
		return runSkill(args[1:], o, stdout)
	}
	admin, err := credential(o.adminFile, o.adminEnv)
	if err != nil {
		return err
	}
	token, err := credential(o.tokenFile, o.tokenEnv)
	if err != nil {
		return err
	}
	c, err := client.New(o.server, admin, token, o.timeout, o.allowHTTP)
	if err != nil {
		return err
	}
	if args[0] == "clients" {
		return runIntegration(ctx, c, token, args[1:], o, stdout)
	}
	command, path, err := resolveCommand(args)
	if err != nil {
		return err
	}
	if o.apply || o.replace || o.embedToken {
		return errors.New("--apply, --replace and --embed-token belong to clients/skill commands")
	}
	if o.secretOut != "" && command.Name != "tokens create" && command.Name != "tokens get" && command.Name != "upstreams credential" {
		return errors.New("--secret-out requires tokens create/get or upstreams credential")
	}
	if command.Mutates && !o.yes && !o.dryRun {
		return errors.New("mutation or billable probe requires --yes; preview with --dry-run")
	}
	query, err := queries(o.query)
	if err != nil {
		return err
	}
	body, err := input(o, stdin)
	if err != nil {
		return err
	}
	body, err = prepareBody(command, body, o)
	if err != nil {
		return err
	}
	body, err = updateBody(ctx, c, command, path, body)
	if err != nil {
		return err
	}
	if o.dryRun {
		target, err := c.URL(path, query)
		if err != nil {
			return err
		}
		return output(stdout, map[string]any{"dry_run": true, "method": command.Method, "url": target,
			"auth": command.Auth, "body": json.RawMessage(bodyOrNull(body))}, o)
	}
	if command.Auth == client.Downstream && o.tokenID != "" {
		token, err = selectedToken(ctx, c, o.tokenID)
		if err != nil {
			return err
		}
		c.SetToken(token)
	}
	if command.Stream {
		if o.out != "" || o.secretOut != "" {
			return errors.New("stream commands write NDJSON to stdout; use shell redirection")
		}
		o.json = true
		failed := false
		err := c.Stream(ctx, command.Method, path, command.Auth, query, body, func(event client.Event) error {
			if command.Name == "upstreams debug" || command.Name == "debug" {
				failed = failed || event.Event == "error"
				if event.Event == "response" {
					raw, _ := json.Marshal(event.Data)
					var reply struct {
						Status int `json:"status_code"`
					}
					json.Unmarshal(raw, &reply)
					failed = failed || reply.Status >= 400
				}
			}
			return output(stdout, event, o)
		})
		if err == nil && failed {
			return errors.New("debug request failed; inspect the streamed result")
		}
		return err
	}
	raw, err := c.Do(ctx, command.Method, path, command.Auth, query, body)
	if err != nil {
		return err
	}
	if err := saveSecret(raw, o.secretOut); err != nil {
		return fmt.Errorf("request succeeded, but credential output failed: %w", err)
	}
	if err := output(stdout, raw, o); err != nil {
		return fmt.Errorf("request succeeded, but output failed: %w", err)
	}
	if command.Name == "upstreams import" {
		var result struct {
			Failed int `json:"failed"`
		}
		json.Unmarshal(raw, &result)
		if result.Failed > 0 {
			return errors.New("some channels failed to import; inspect the returned items before retrying")
		}
	}
	if command.Name == "upstreams test" || command.Name == "upstreams test-model" {
		var result struct {
			OK bool `json:"ok"`
		}
		json.Unmarshal(raw, &result)
		if !result.OK {
			return errors.New("upstream probe failed; inspect the returned result")
		}
	}
	if command.Name == "upstreams balance" || command.Name == "upstreams balance-sub2api" {
		var result struct {
			Keys []struct {
				OK bool `json:"ok"`
			} `json:"keys"`
		}
		json.Unmarshal(raw, &result)
		for _, key := range result.Keys {
			if !key.OK {
				return errors.New("one or more balance probes failed; inspect the returned keys")
			}
		}
	}
	return nil
}

func bodyOrNull(body []byte) []byte {
	if body == nil {
		return []byte("null")
	}
	return body
}

func queries(values []string) (url.Values, error) {
	result := url.Values{}
	for _, value := range values {
		key, data, ok := strings.Cut(value, "=")
		if !ok || key == "" {
			return nil, errors.New("--query expects key=value")
		}
		result.Add(key, data)
	}
	return result, nil
}

func positiveID(value string) bool {
	n, err := strconv.ParseInt(value, 10, 64)
	return err == nil && n > 0
}

func resolveCommand(args []string) (Command, string, error) {
	aliases := map[string]string{"upstream": "upstreams", "token": "tokens", "group": "groups", "log": "logs", "model": "models"}
	args = append([]string(nil), args...)
	if alias := aliases[args[0]]; alias != "" {
		args[0] = alias
	}
	for _, c := range commands {
		words := strings.Fields(c.Name)
		if len(args) < len(words) || strings.Join(args[:len(words)], " ") != c.Name {
			continue
		}
		rest, path := args[len(words):], c.Path
		for _, placeholder := range []string{"{id}", "{field}"} {
			if !strings.Contains(path, placeholder) {
				continue
			}
			if len(rest) == 0 {
				return c, "", fmt.Errorf("%s requires %s", c.Name, placeholder)
			}
			value := rest[0]
			rest = rest[1:]
			if placeholder == "{id}" && !positiveID(value) {
				return c, "", errors.New("ID must be a positive integer")
			}
			if placeholder == "{field}" && value != "downstream_request" && value != "upstream_request" && value != "upstream_response" && value != "downstream_response" {
				return c, "", errors.New("snapshot field must be downstream_request, upstream_request, upstream_response or downstream_response")
			}
			path = strings.ReplaceAll(path, placeholder, value)
		}
		if len(rest) != 0 {
			return c, "", errors.New("unexpected positional arguments")
		}
		return c, path, nil
	}
	return Command{}, "", errors.New("unknown command; use wildtokenctl help or commands --json")
}

func selectedToken(ctx context.Context, c *client.Client, id string) (string, error) {
	if !positiveID(id) {
		return "", errors.New("--token-id must be positive")
	}
	raw, err := c.Do(ctx, "GET", "/api/admin/tokens/"+id, client.Admin, nil, nil)
	if err != nil {
		return "", err
	}
	var token struct {
		Token   string `json:"token"`
		Enabled bool   `json:"enabled"`
	}
	if json.Unmarshal(raw, &token) != nil || token.Token == "" || !token.Enabled {
		return "", errors.New("selected token is disabled or has no recoverable value")
	}
	return token.Token, nil
}
