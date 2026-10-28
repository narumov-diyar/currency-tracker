// Пакет проверяет путь пользователя целиком: настоящий HTTP-сервер,
// настоящая база и настоящий канал уведомлений. Заглушек нет ни одной —
// в остальных тестах каждый слой проверяется отдельно, а здесь важно,
// что они сходятся друг с другом.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/narumov-diyar/currency-tracker/internal/alerts"
	"github.com/narumov-diyar/currency-tracker/internal/auth"
	"github.com/narumov-diyar/currency-tracker/internal/devdata"
	"github.com/narumov-diyar/currency-tracker/internal/httpapi"
	"github.com/narumov-diyar/currency-tracker/internal/storage"
	"github.com/narumov-diyar/currency-tracker/internal/stream"
)

const (
	tokenTTL   = time.Hour
	authSecret = "e2e-secret-key-not-shorter-than-32-chars"
)

// Сценарий целиком: регистрация, список пар, график с аналитикой, правило
// оповещения и уведомление от сохранённой свечи.
func TestUserPathFromRegistrationToNotification(t *testing.T) {
	env := setup(t)

	// ── регистрация ──
	var registered struct {
		Token string `json:"token"`
	}
	env.do(t, http.MethodPost, "/api/auth/register", "",
		map[string]string{"email": "e2e@example.com", "password": "secret-password"},
		http.StatusCreated, &registered)
	if registered.Token == "" {
		t.Fatal("регистрация не вернула токен")
	}
	token := registered.Token

	// Повторная регистрация того же адреса отклоняется.
	env.do(t, http.MethodPost, "/api/auth/register", "",
		map[string]string{"email": "e2e@example.com", "password": "secret-password"},
		http.StatusConflict, nil)

	// Без токена защищённый раздел недоступен.
	env.do(t, http.MethodGet, "/api/watchlist", "", nil, http.StatusUnauthorized, nil)

	// ── добавление пары ──
	env.do(t, http.MethodPost, "/api/watchlist", token,
		map[string]string{"base": "BTC", "quote": "USDT"}, http.StatusCreated, nil)

	var list []struct {
		ID    int64   `json:"id"`
		Rate  *string `json:"rate"`
		Stale bool    `json:"stale"`
		Base  struct {
			Symbol string `json:"symbol"`
		} `json:"base"`
	}
	env.do(t, http.MethodGet, "/api/watchlist", token, nil, http.StatusOK, &list)
	if len(list) != 1 {
		t.Fatalf("в списке %d пар, ожидалась одна", len(list))
	}
	if list[0].Base.Symbol != "BTC" {
		t.Errorf("база пары = %s, ожидалась BTC", list[0].Base.Symbol)
	}
	if list[0].Rate == nil {
		t.Fatal("курс пары пуст, хотя свечи засеяны")
	}
	if list[0].Stale {
		t.Error("пара помечена устаревшей, хотя свечи только что записаны")
	}

	// ── график и аналитика ──
	var history struct {
		Period string `json:"period"`
		Base   *struct {
			Symbol     string  `json:"symbol"`
			Resolution int16   `json:"resolution"`
			Candles    [][]any `json:"candles"`
		} `json:"base"`
		Quote *struct {
			Candles [][]any `json:"candles"`
		} `json:"quote"`
		Analytics struct {
			BaseChange  *float64 `json:"base_change"`
			Correlation *float64 `json:"correlation"`
		} `json:"analytics"`
	}
	env.do(t, http.MethodGet, "/api/history?base=BTC&quote=USDT&period=1h&mode=compare",
		token, nil, http.StatusOK, &history)

	if history.Base == nil || history.Quote == nil {
		t.Fatal("режим сравнения вернул не оба ряда")
	}
	if len(history.Base.Candles) == 0 {
		t.Fatal("ряд базы пуст")
	}
	if history.Base.Resolution != 1 {
		t.Errorf("разрешение = %d, для часа ожидалась минута", history.Base.Resolution)
	}
	if history.Analytics.BaseChange == nil {
		t.Error("изменение курса не посчитано")
	}

	// ── правило оповещения ──
	last := env.lastClose(t, "BTC")
	target := last * 1.05

	var rule struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	env.do(t, http.MethodPost, "/api/alerts", token, map[string]any{
		"target_type":    "asset",
		"symbol":         "BTC",
		"condition_type": "threshold",
		"direction":      "above",
		"target_value":   formatPrice(target),
	}, http.StatusCreated, &rule)
	if rule.Status != "active" {
		t.Fatalf("правило создано в состоянии %q, ожидалось active", rule.Status)
	}

	// Пока порог не пересечён, уведомлений нет.
	var empty []any
	env.do(t, http.MethodGet, "/api/notifications", token, nil, http.StatusOK, &empty)
	if len(empty) != 0 {
		t.Fatalf("уведомлений %d, пока порог не пересечён их быть не должно", len(empty))
	}

	// ── срабатывание ──
	// Свеча выше порога и уведомление в канал: так же это делает сборщик.
	env.saveCandle(t, "BTC", target*1.02)

	var notifications []struct {
		AlertRuleID int64  `json:"alert_rule_id"`
		Target      string `json:"target"`
		Direction   string `json:"direction"`
	}
	env.waitFor(t, "уведомление о пересечении порога",
		func() { env.notify(t, "BTC") },
		func() bool {
			notifications = notifications[:0]
			env.do(t, http.MethodGet, "/api/notifications", token, nil, http.StatusOK, &notifications)
			return len(notifications) > 0
		})

	if notifications[0].AlertRuleID != rule.ID {
		t.Errorf("уведомление от правила %d, ожидалось от %d", notifications[0].AlertRuleID, rule.ID)
	}
	if notifications[0].Target != "BTC" {
		t.Errorf("цель уведомления = %q, ожидалась BTC", notifications[0].Target)
	}

	// Правило переведено в сработавшее.
	var rules []struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	env.do(t, http.MethodGet, "/api/alerts", token, nil, http.StatusOK, &rules)
	if len(rules) != 1 || rules[0].Status != "triggered" {
		t.Errorf("правила = %+v, ожидалось одно в состоянии triggered", rules)
	}

	// Повторная свеча выше порога не порождает второго уведомления.
	env.saveCandle(t, "BTC", target*1.03)
	time.Sleep(500 * time.Millisecond)

	var again []any
	env.do(t, http.MethodGet, "/api/notifications", token, nil, http.StatusOK, &again)
	if len(again) != 1 {
		t.Errorf("уведомлений %d, сработавшее правило не должно уведомлять повторно", len(again))
	}

	// ── отметка о прочтении ──
	env.do(t, http.MethodPost, "/api/notifications/seen", token, map[string]any{}, http.StatusNoContent, nil)
	env.do(t, http.MethodGet, "/api/notifications", token, nil, http.StatusOK, &again)
	if len(again) != 0 {
		t.Errorf("после отметки осталось %d непрочитанных", len(again))
	}
}

// ───────────────────────── окружение ─────────────────────────

type env struct {
	server *httptest.Server
	pool   *pgxpool.Pool
	hub    *stream.Hub
}

func setup(t *testing.T) *env {
	t.Helper()

	pool := testPool(t)
	ctx := context.Background()
	if _, err := storage.Migrate(ctx, pool); err != nil {
		t.Fatalf("миграции: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e := &env{pool: pool}
	e.seedCandles(t)

	// Движок правил слушает тот же канал, что и в рабочем запуске.
	listenerCtx, stop := context.WithCancel(ctx)
	t.Cleanup(stop)
	go alerts.NewListener(pool, alerts.NewService(storage.NewAlerts(pool), logger), logger).Run(listenerCtx)

	hub := stream.NewHub(stream.DefaultSize)
	e.hub = hub
	router := httpapi.NewRouter(httpapi.Deps{
		DB:            pool,
		Users:         storage.NewUsers(pool),
		Assets:        storage.NewAssets(pool),
		Pairs:         storage.NewPairs(pool),
		Candles:       storage.NewCandles(pool),
		Alerts:        storage.NewAlerts(pool),
		Notifications: storage.NewNotifications(pool),
		Hub:           hub,
		Tokens:        auth.NewTokenIssuer(authSecret, tokenTTL),
		Logger:        logger,
	})

	e.server = httptest.NewServer(router)
	t.Cleanup(e.server.Close)

	return e
}

// do выполняет запрос и проверяет код ответа. Тело разбирается, если out задан.
func (e *env) do(t *testing.T, method, path, token string, body any, wantStatus int, out any) {
	t.Helper()

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("сериализация тела: %v", err)
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, e.server.URL+path, reader)
	if err != nil {
		t.Fatalf("запрос %s %s: %v", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	res, err := e.server.Client().Do(req)
	if err != nil {
		t.Fatalf("запрос %s %s: %v", method, path, err)
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != wantStatus {
		t.Fatalf("%s %s вернул %d, ожидалось %d: %s",
			method, path, res.StatusCode, wantStatus, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("разбор ответа %s %s: %v (%s)", method, path, err, raw)
	}
}

// waitFor ждёт выполнения условия, повторяя уведомление в канал.
//
// Слушатель оформляет подписку в отдельной горутине, и первое уведомление
// может уйти до того, как она состоится. Проверить готовность подписки
// нечем: pg_listening_channels отвечает только за своё соединение, а
// слушатель держит другое. Поэтому уведомление просто повторяется —
// правило всё равно сработает не более одного раза.
func (e *env) waitFor(t *testing.T, what string, repeat func(), done func() bool) {
	t.Helper()

	deadline := time.Now().Add(15 * time.Second)
	for attempt := 0; time.Now().Before(deadline); attempt++ {
		if done() {
			return
		}
		if repeat != nil && attempt > 0 && attempt%5 == 0 {
			repeat()
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("не дождались: %s", what)
}

func (e *env) assetID(t *testing.T, symbol string) int {
	t.Helper()

	var id int
	if err := e.pool.QueryRow(context.Background(),
		`SELECT id FROM assets WHERE symbol = $1`, symbol).Scan(&id); err != nil {
		t.Fatalf("актив %s: %v", symbol, err)
	}
	return id
}

// seedCandles наполняет историю двух активов пары: без неё не будет ни курса
// в списке, ни ряда на графике.
func (e *env) seedCandles(t *testing.T) {
	t.Helper()

	ctx := context.Background()
	rnd := rand.New(rand.NewSource(42))

	// Генератор заканчивает ряд за шаг до переданного момента, а момент
	// округляется вниз до минуты. Без добавочной минуты свежайшая свеча
	// оказывалась почти двухминутной уже при записи, и пара успевала стать
	// устаревшей до проверки: сервер считает устаревшим всё старше двух
	// интервалов актива, то есть 120 секунд для криптовалюты.
	now := time.Now().UTC().Truncate(time.Minute).Add(time.Minute)

	for _, symbol := range []string{"BTC", "USDT"} {
		id := e.assetID(t, symbol)
		candles := devdata.Generate(
			devdata.Asset{ID: id, Symbol: symbol, ResolutionSeconds: 60}, 2*time.Hour, now, rnd)

		rows := make([][]any, 0, len(candles))
		for _, c := range candles {
			rows = append(rows, []any{c.AssetID, int16(1), c.CollectedAt, c.Open, c.High, c.Low, c.Close})
		}
		_, err := e.pool.CopyFrom(ctx, pgx.Identifier{"price_candles"},
			[]string{"asset_id", "resolution", "collected_at", "open_price", "high_price", "low_price", "close_price"},
			pgx.CopyFromRows(rows))
		if err != nil {
			t.Fatalf("запись свечей %s: %v", symbol, err)
		}
	}
}

func (e *env) lastClose(t *testing.T, symbol string) float64 {
	t.Helper()

	var price float64
	err := e.pool.QueryRow(context.Background(), `
		SELECT close_price::float8 FROM price_candles c
		JOIN assets a ON a.id = c.asset_id
		WHERE a.symbol = $1 AND c.resolution = 1
		ORDER BY collected_at DESC LIMIT 1`, symbol).Scan(&price)
	if err != nil {
		t.Fatalf("последняя цена %s: %v", symbol, err)
	}
	return price
}

// saveCandle повторяет то, что делает сборщик: записывает свечу и сообщает
// о ней в канал, по которому сервер проверяет правила.
func (e *env) saveCandle(t *testing.T, symbol string, price float64) {
	t.Helper()

	id := e.assetID(t, symbol)
	at := time.Now().UTC().Truncate(time.Minute).Add(time.Minute)

	_, err := e.pool.Exec(context.Background(), `
		INSERT INTO price_candles (asset_id, resolution, collected_at,
		                           open_price, high_price, low_price, close_price)
		VALUES ($1, 1, $2, $3, $3, $3, $3)
		ON CONFLICT (asset_id, resolution, collected_at)
		DO UPDATE SET close_price = excluded.close_price`, id, at, price)
	if err != nil {
		t.Fatalf("запись свечи: %v", err)
	}
	e.notify(t, symbol)
}

func (e *env) notify(t *testing.T, symbol string) {
	t.Helper()

	payload, err := json.Marshal(map[string]int{"asset_id": e.assetID(t, symbol)})
	if err != nil {
		t.Fatalf("сериализация уведомления: %v", err)
	}
	if _, err := e.pool.Exec(context.Background(),
		`SELECT pg_notify($1, $2)`, alerts.Channel, string(payload)); err != nil {
		t.Fatalf("уведомление в канал: %v", err)
	}
}

// Цена передаётся строкой: numeric(18,8) не укладывается в double без
// потери значащих цифр, и остальной код обращается с ней так же.
func formatPrice(v float64) string {
	return strconv.FormatFloat(v, 'f', 8, 64)
}

// testPool выдаёт отдельную схему под прогон: сквозной сценарий пишет
// в те же таблицы, что и разработка, и затирать её данные нельзя.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}

	ctx := context.Background()
	schema := "e2e_" + strings.ToLower(strings.NewReplacer("/", "_", " ", "_").Replace(t.Name()))

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("разбор строки подключения: %v", err)
	}
	cfg.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error {
		_, err := conn.Exec(ctx, "SET search_path TO "+schema)
		return err
	}

	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	defer admin.Close()

	if _, err := admin.Exec(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE; CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("создание схемы: %v", err)
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("подключение к схеме: %v", err)
	}

	t.Cleanup(func() {
		pool.Close()
		cleanup, err := pgxpool.New(ctx, dsn)
		if err != nil {
			return
		}
		defer cleanup.Close()
		_, _ = cleanup.Exec(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
	})

	return pool
}

// Обрыв соединения со зрителем должен снимать подписку: по списку
// просматриваемых активов сборщик решает, какие подписки держать на бирже,
// и оставшийся зритель заставил бы его качать поток впустую.
//
// Клиент в этот канал ничего не шлёт, поэтому обрыв замечается только чтением
// соединения — без него сервер молчит, пока нет котировок, и ничего не узнаёт.
func TestStreamReleasesSubscriptionOnDisconnect(t *testing.T) {
	env := setup(t)

	var registered struct {
		Token string `json:"token"`
	}
	env.do(t, http.MethodPost, "/api/auth/register", "",
		map[string]string{"email": "stream@example.com", "password": "secret-password"},
		http.StatusCreated, &registered)

	if watched := env.hub.Watched(); len(watched) != 0 {
		t.Fatalf("до подключения просматриваются %v, ожидался пустой список", watched)
	}

	url := "ws" + strings.TrimPrefix(env.server.URL, "http") +
		"/api/stream?base=BTC&quote=USDT&token=" + registered.Token

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("подключение к потоку: %v", err)
	}

	env.waitFor(t, "появление зрителя в списке", nil,
		func() bool { return len(env.hub.Watched()) == 2 })

	conn.CloseNow()

	env.waitFor(t, "снятие подписки после обрыва", nil,
		func() bool { return len(env.hub.Watched()) == 0 })
}
