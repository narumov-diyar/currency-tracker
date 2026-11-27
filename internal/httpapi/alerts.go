package httpapi

import (
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/narumov-diyar/currency-tracker/internal/storage"
)

type alertRequest struct {
	TargetType    string `json:"target_type"`
	Symbol        string `json:"symbol"`
	PairID        *int64 `json:"pair_id"`
	ConditionType string `json:"condition_type"`
	Direction     string `json:"direction"`
	TargetValue   string `json:"target_value"`
	WindowMinutes *int   `json:"window_minutes"`
}

type alertUpdateRequest struct {
	TargetValue   *string `json:"target_value"`
	Direction     *string `json:"direction"`
	WindowMinutes *int    `json:"window_minutes"`
}

func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	userID, _ := UserID(r.Context())

	rules, err := s.alerts.List(r.Context(), userID)
	if err != nil {
		s.fail(w, "list alerts", err)
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func (s *Server) createAlert(w http.ResponseWriter, r *http.Request) {
	userID, _ := UserID(r.Context())

	var req alertRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}

	rule := storage.NewAlertRule{
		UserID:        userID,
		TargetType:    strings.ToLower(strings.TrimSpace(req.TargetType)),
		ConditionType: strings.ToLower(strings.TrimSpace(req.ConditionType)),
		Direction:     strings.ToLower(strings.TrimSpace(req.Direction)),
		TargetValue:   strings.TrimSpace(req.TargetValue),
		WindowMinutes: req.WindowMinutes,
	}

	if message := validateAlert(rule); message != "" {
		writeError(w, http.StatusBadRequest, message)
		return
	}

	switch rule.TargetType {
	case storage.TargetAsset:
		asset, ok := s.resolveAsset(w, r, upper(req.Symbol))
		if !ok {
			return
		}
		rule.AssetID = &asset.ID

	case storage.TargetPair:
		if req.PairID == nil {
			writeError(w, http.StatusBadRequest, "pair_id is required for a pair target")
			return
		}
		owned, err := s.pairs.Owned(r.Context(), userID, *req.PairID)
		if err != nil {
			s.fail(w, "check pair ownership", err)
			return
		}
		// Чужая пара отвечает как несуществующая: иначе по коду ответа
		// можно было бы перебрать идентификаторы чужих пар.
		if !owned {
			writeError(w, http.StatusBadRequest, "unknown pair")
			return
		}
		rule.PairID = req.PairID
	}

	created, err := s.alerts.Create(r.Context(), rule)
	if err != nil {
		s.fail(w, "create alert", err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) updateAlert(w http.ResponseWriter, r *http.Request) {
	userID, _ := UserID(r.Context())

	ruleID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}

	var req alertUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}

	if req.TargetValue != nil && !isPositiveNumber(*req.TargetValue) {
		writeError(w, http.StatusBadRequest, "target_value must be a positive number")
		return
	}
	if req.Direction != nil {
		direction := strings.ToLower(strings.TrimSpace(*req.Direction))
		if !isDirection(direction) {
			writeError(w, http.StatusBadRequest, "direction must be above or below")
			return
		}
		req.Direction = &direction
	}
	if req.WindowMinutes != nil && *req.WindowMinutes <= 0 {
		writeError(w, http.StatusBadRequest, "window_minutes must be positive")
		return
	}

	updated, err := s.alerts.Update(r.Context(), userID, ruleID, storage.AlertUpdate{
		TargetValue:   req.TargetValue,
		Direction:     req.Direction,
		WindowMinutes: req.WindowMinutes,
	})
	if errors.Is(err, storage.ErrAlertNotFound) {
		writeError(w, http.StatusNotFound, "alert rule not found")
		return
	}
	if err != nil {
		s.fail(w, "update alert", err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) deleteAlert(w http.ResponseWriter, r *http.Request) {
	userID, _ := UserID(r.Context())

	ruleID, ok := parseID(w, r.PathValue("id"))
	if !ok {
		return
	}

	err := s.alerts.Delete(r.Context(), userID, ruleID)
	if errors.Is(err, storage.ErrAlertNotFound) {
		writeError(w, http.StatusNotFound, "alert rule not found")
		return
	}
	if err != nil {
		s.fail(w, "delete alert", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validateAlert(rule storage.NewAlertRule) string {
	if rule.TargetType != storage.TargetAsset && rule.TargetType != storage.TargetPair {
		return "target_type must be asset or pair"
	}
	if rule.ConditionType != storage.ConditionThreshold && rule.ConditionType != storage.ConditionPercent {
		return "condition_type must be threshold or percent"
	}
	if !isDirection(rule.Direction) {
		return "direction must be above or below"
	}
	if !isPositiveNumber(rule.TargetValue) {
		return "target_value must be a positive number"
	}
	// Процентное правило без интервала наблюдения не имеет смысла:
	// непонятно, за какое время измерять изменение.
	if rule.ConditionType == storage.ConditionPercent {
		if rule.WindowMinutes == nil || *rule.WindowMinutes <= 0 {
			return "window_minutes is required for a percent condition"
		}
	}
	return ""
}

func isDirection(value string) bool {
	return value == "above" || value == "below"
}

var (
	alertValuePattern = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
	minAlertValue     = big.NewRat(1, 100000000)
	maxAlertValue     = big.NewRat(999999999999999999, 100000000)
)

// Приблизительная проверка отсекает заведомо далёкие значения, а точная
// сравнивает границы numeric(18,8), которые float64 различить не может.
func isPositiveNumber(value string) bool {
	if !alertValuePattern.MatchString(value) {
		return false
	}
	approx, err := strconv.ParseFloat(value, 64)
	if err != nil || approx < 1e-8 || approx > 1e10 {
		return false
	}
	parsed, ok := new(big.Rat).SetString(value)
	return ok && parsed.Cmp(minAlertValue) >= 0 && parsed.Cmp(maxAlertValue) <= 0
}

func parseID(w http.ResponseWriter, raw string) (int64, bool) {
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "id must be a number")
		return 0, false
	}
	return id, true
}

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	userID, _ := UserID(r.Context())

	list, err := s.notifications.Unseen(r.Context(), userID)
	if err != nil {
		s.fail(w, "list notifications", err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// markNotificationsSeen гасит значок непрочитанного. Сами уведомления
// остаются: история срабатываний должна быть видна.
func (s *Server) markNotificationsSeen(w http.ResponseWriter, r *http.Request) {
	userID, _ := UserID(r.Context())

	if err := s.notifications.MarkSeen(r.Context(), userID); err != nil {
		s.fail(w, "mark notifications seen", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
