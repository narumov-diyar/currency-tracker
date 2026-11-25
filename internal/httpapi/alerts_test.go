package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/narumov-diyar/currency-tracker/internal/auth"
	"github.com/narumov-diyar/currency-tracker/internal/storage"
)

type stubAlerts struct {
	byID    map[int64]storage.AlertRule
	owners  map[int64]int64
	created []storage.NewAlertRule
	nextID  int64
	updates []storage.AlertUpdate
}

func newStubAlerts() *stubAlerts {
	return &stubAlerts{byID: map[int64]storage.AlertRule{}, owners: map[int64]int64{}, nextID: 1}
}

func (s *stubAlerts) List(_ context.Context, userID int64) ([]storage.AlertRule, error) {
	rules := make([]storage.AlertRule, 0)
	for id, rule := range s.byID {
		if s.owners[id] == userID {
			rules = append(rules, rule)
		}
	}
	return rules, nil
}

func (s *stubAlerts) Create(_ context.Context, rule storage.NewAlertRule) (storage.AlertRule, error) {
	s.created = append(s.created, rule)

	id := s.nextID
	s.nextID++
	s.owners[id] = rule.UserID
	stored := storage.AlertRule{
		ID: id, TargetType: rule.TargetType, PairID: rule.PairID,
		ConditionType: rule.ConditionType, Direction: rule.Direction,
		TargetValue: rule.TargetValue, WindowMinutes: rule.WindowMinutes,
		Status: storage.StatusActive, CreatedAt: time.Now(),
	}
	s.byID[id] = stored
	return stored, nil
}

func (s *stubAlerts) Update(_ context.Context, userID, ruleID int64, update storage.AlertUpdate) (storage.AlertRule, error) {
	s.updates = append(s.updates, update)
	if owner, ok := s.owners[ruleID]; !ok || owner != userID {
		return storage.AlertRule{}, storage.ErrAlertNotFound
	}

	rule := s.byID[ruleID]
	if update.TargetValue != nil {
		rule.TargetValue = *update.TargetValue
	}
	if update.Direction != nil {
		rule.Direction = *update.Direction
	}
	rule.Status = storage.StatusActive
	s.byID[ruleID] = rule
	return rule, nil
}

func (s *stubAlerts) Delete(_ context.Context, userID, ruleID int64) error {
	if owner, ok := s.owners[ruleID]; !ok || owner != userID {
		return storage.ErrAlertNotFound
	}
	delete(s.owners, ruleID)
	delete(s.byID, ruleID)
	return nil
}

type alertEnv struct {
	handler http.Handler
	token   string
	alerts  *stubAlerts
	pairs   *stubPairs
}

func newAlertEnv(t *testing.T) alertEnv {
	t.Helper()

	tokens := auth.NewTokenIssuer(strings.Repeat("k", 32), time.Hour)
	alerts, pairs := newStubAlerts(), newStubPairs()
	handler := NewRouter(Deps{
		DB:      stubPinger{},
		Users:   newStubUsers(),
		Assets:  newStubAssets(),
		Pairs:   pairs,
		Candles: &stubCandles{},
		Alerts:  alerts,
		Tokens:  tokens,
		Logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	token, _, err := tokens.Issue(1)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	return alertEnv{handler: handler, token: token, alerts: alerts, pairs: pairs}
}

func (e alertEnv) do(t *testing.T, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()

	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.handler.ServeHTTP(rec, req)
	return rec
}

func TestAlertsRequireToken(t *testing.T) {
	env := newAlertEnv(t)

	tests := []struct {
		method string
		path   string
		body   string
	}{
		{method: http.MethodGet, path: "/api/alerts"},
		{method: http.MethodPost, path: "/api/alerts", body: `{}`},
		{method: http.MethodPatch, path: "/api/alerts/1", body: `{}`},
		{method: http.MethodDelete, path: "/api/alerts/1"},
	}

	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			if rec := env.do(t, tt.method, tt.path, tt.body, ""); rec.Code != http.StatusUnauthorized {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
			}
		})
	}
}

func TestCreateAssetAlert(t *testing.T) {
	env := newAlertEnv(t)

	body := `{"target_type":"asset","symbol":"btc","condition_type":"threshold","direction":"above","target_value":"70000"}`
	rec := env.do(t, http.MethodPost, "/api/alerts", body, env.token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusCreated, rec.Body)
	}

	if len(env.alerts.created) != 1 {
		t.Fatalf("created %d rules, want 1", len(env.alerts.created))
	}
	created := env.alerts.created[0]
	if created.AssetID == nil || *created.AssetID != 1 {
		t.Errorf("asset id = %v, want the resolved BTC id", created.AssetID)
	}
	if created.PairID != nil {
		t.Error("an asset rule must not carry a pair")
	}

	var rule storage.AlertRule
	if err := json.Unmarshal(rec.Body.Bytes(), &rule); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rule.Status != storage.StatusActive {
		t.Errorf("status = %q, want %q", rule.Status, storage.StatusActive)
	}
}

func TestCreatePairAlertChecksOwnership(t *testing.T) {
	env := newAlertEnv(t)

	// Пара первого пользователя.
	env.do(t, http.MethodPost, "/api/watchlist", `{"base":"BTC","quote":"USDT"}`, env.token)

	body := `{"target_type":"pair","pair_id":1,"condition_type":"threshold","direction":"below","target_value":"0.04"}`
	if rec := env.do(t, http.MethodPost, "/api/alerts", body, env.token); rec.Code != http.StatusCreated {
		t.Fatalf("own pair: status = %d, want %d: %s", rec.Code, http.StatusCreated, rec.Body)
	}

	// Та же пара глазами другого пользователя должна выглядеть несуществующей.
	other := auth.NewTokenIssuer(strings.Repeat("k", 32), time.Hour)
	otherToken, _, err := other.Issue(2)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	if rec := env.do(t, http.MethodPost, "/api/alerts", body, otherToken); rec.Code != http.StatusBadRequest {
		t.Errorf("another user's pair: status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestCreateAlertValidation(t *testing.T) {
	env := newAlertEnv(t)

	tests := []struct {
		name string
		body string
	}{
		{name: "malformed json", body: `{`},
		{name: "unknown target type", body: `{"target_type":"portfolio","symbol":"BTC","condition_type":"threshold","direction":"above","target_value":"1"}`},
		{name: "unknown condition", body: `{"target_type":"asset","symbol":"BTC","condition_type":"trend","direction":"above","target_value":"1"}`},
		{name: "unknown direction", body: `{"target_type":"asset","symbol":"BTC","condition_type":"threshold","direction":"sideways","target_value":"1"}`},
		{name: "zero value", body: `{"target_type":"asset","symbol":"BTC","condition_type":"threshold","direction":"above","target_value":"0"}`},
		{name: "negative value", body: `{"target_type":"asset","symbol":"BTC","condition_type":"threshold","direction":"above","target_value":"-5"}`},
		{name: "value is not a number", body: `{"target_type":"asset","symbol":"BTC","condition_type":"threshold","direction":"above","target_value":"скоро"}`},
		{name: "unknown asset", body: `{"target_type":"asset","symbol":"NOPE","condition_type":"threshold","direction":"above","target_value":"1"}`},
		{name: "pair target without pair_id", body: `{"target_type":"pair","condition_type":"threshold","direction":"above","target_value":"1"}`},
		// Процент без интервала наблюдения не имеет смысла.
		{name: "percent without window", body: `{"target_type":"asset","symbol":"BTC","condition_type":"percent","direction":"above","target_value":"5"}`},
		{name: "percent with zero window", body: `{"target_type":"asset","symbol":"BTC","condition_type":"percent","direction":"above","target_value":"5","window_minutes":0}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if rec := env.do(t, http.MethodPost, "/api/alerts", tt.body, env.token); rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d: %s", rec.Code, http.StatusBadRequest, rec.Body)
			}
		})
	}
}

func TestCreatePercentAlert(t *testing.T) {
	env := newAlertEnv(t)

	body := `{"target_type":"asset","symbol":"BTC","condition_type":"percent","direction":"above","target_value":"5","window_minutes":60}`
	if rec := env.do(t, http.MethodPost, "/api/alerts", body, env.token); rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusCreated, rec.Body)
	}

	created := env.alerts.created[0]
	if created.WindowMinutes == nil || *created.WindowMinutes != 60 {
		t.Errorf("window = %v, want 60", created.WindowMinutes)
	}
}

func TestUpdateAndDeleteAlert(t *testing.T) {
	env := newAlertEnv(t)
	body := `{"target_type":"asset","symbol":"BTC","condition_type":"threshold","direction":"above","target_value":"70000"}`
	env.do(t, http.MethodPost, "/api/alerts", body, env.token)

	rec := env.do(t, http.MethodPatch, "/api/alerts/1", `{"target_value":"75000"}`, env.token)
	if rec.Code != http.StatusOK {
		t.Fatalf("patch status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body)
	}

	var rule storage.AlertRule
	if err := json.Unmarshal(rec.Body.Bytes(), &rule); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if rule.TargetValue != "75000" {
		t.Errorf("target value = %q, want 75000", rule.TargetValue)
	}

	if rec := env.do(t, http.MethodDelete, "/api/alerts/1", "", env.token); rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, want %d", rec.Code, http.StatusNoContent)
	}
	if rec := env.do(t, http.MethodDelete, "/api/alerts/1", "", env.token); rec.Code != http.StatusNotFound {
		t.Errorf("repeated delete status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

// Чужое правило выглядит как несуществующее, иначе по коду ответа можно было
// бы узнать, какие идентификаторы заняты.
func TestAlertsOfAnotherUserAreHidden(t *testing.T) {
	env := newAlertEnv(t)
	body := `{"target_type":"asset","symbol":"BTC","condition_type":"threshold","direction":"above","target_value":"70000"}`
	env.do(t, http.MethodPost, "/api/alerts", body, env.token)

	other := auth.NewTokenIssuer(strings.Repeat("k", 32), time.Hour)
	otherToken, _, err := other.Issue(2)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	if rec := env.do(t, http.MethodPatch, "/api/alerts/1", `{"target_value":"1"}`, otherToken); rec.Code != http.StatusNotFound {
		t.Errorf("patch status = %d, want %d", rec.Code, http.StatusNotFound)
	}
	if rec := env.do(t, http.MethodDelete, "/api/alerts/1", "", otherToken); rec.Code != http.StatusNotFound {
		t.Errorf("delete status = %d, want %d", rec.Code, http.StatusNotFound)
	}

	rec := env.do(t, http.MethodGet, "/api/alerts", "", otherToken)
	var rules []storage.AlertRule
	if err := json.Unmarshal(rec.Body.Bytes(), &rules); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rules) != 0 {
		t.Errorf("another user sees %d rules, want none", len(rules))
	}
}

func TestAlertTargetValueBounds(t *testing.T) {
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"NaN", false}, {"Inf", false}, {"-Inf", false}, {"0", false}, {"-1", false},
		{"abc", false}, {"0.000000001", false}, {"10000000000", false},
		{"1e10", false}, {"1_000", false}, {"0x1p0", false},
		{"0.00000001", true}, {"9999999999.99999999", true}, {"1e-8", true},
	} {
		for _, method := range []string{http.MethodPost, http.MethodPatch} {
			t.Run(method+"/"+tc.value, func(t *testing.T) {
				e := newAlertEnv(t)
				path := "/api/alerts"
				body := fmt.Sprintf(`{"target_type":"asset","symbol":"BTC","condition_type":"threshold","direction":"above","target_value":%q}`, tc.value)
				want := http.StatusBadRequest
				if method == http.MethodPatch {
					e.alerts.owners[1] = 1
					path += "/1"
					body = fmt.Sprintf(`{"target_value":%q}`, tc.value)
				}
				if tc.valid {
					want = http.StatusCreated
					if method == http.MethodPatch {
						want = http.StatusOK
					}
				}
				rec := e.do(t, method, path, body, e.token)
				calls := len(e.alerts.created) + len(e.alerts.updates)
				if rec.Code != want || calls != map[bool]int{true: 1, false: 0}[tc.valid] {
					t.Errorf("status=%d, calls=%d, want status=%d for valid=%t", rec.Code, calls, want, tc.valid)
				}
			})
		}
	}
}

func TestAlertPatchNormalizesDirectionAndValidatesWindow(t *testing.T) {
	for _, tc := range []struct{ body, direction string }{
		{`{"direction":"ABOVE"}`, "above"}, {`{"direction":" below "}`, "below"},
		{`{"direction":"sideways"}`, ""}, {`{"window_minutes":0}`, ""}, {`{"window_minutes":-1}`, ""},
	} {
		t.Run(tc.body, func(t *testing.T) {
			e := newAlertEnv(t)
			e.alerts.owners[1] = 1
			rec := e.do(t, http.MethodPatch, "/api/alerts/1", tc.body, e.token)
			if tc.direction == "" {
				if rec.Code != http.StatusBadRequest || len(e.alerts.updates) != 0 {
					t.Errorf("invalid patch: status=%d, updates=%v", rec.Code, e.alerts.updates)
				}
				return
			}
			if rec.Code != http.StatusOK || len(e.alerts.updates) != 1 || *e.alerts.updates[0].Direction != tc.direction {
				t.Errorf("status=%d, updates=%v, want direction %q", rec.Code, e.alerts.updates, tc.direction)
			}
		})
	}
}
