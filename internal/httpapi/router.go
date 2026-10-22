package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/narumov-diyar/currency-tracker/internal/storage"
	"github.com/narumov-diyar/currency-tracker/internal/stream"
)

// Pinger описывает ту часть пула соединений, которая нужна обработчикам.
// Благодаря этому их можно проверять без поднятой базы.
type Pinger interface {
	Ping(ctx context.Context) error
}

type UserStore interface {
	Create(ctx context.Context, email, passwordHash string) (int64, error)
	ByEmail(ctx context.Context, email string) (storage.User, error)
}

type TokenIssuer interface {
	Issue(userID int64) (string, time.Time, error)
	Parse(raw string) (int64, error)
}

type AssetStore interface {
	List(ctx context.Context) ([]storage.Asset, error)
	BySymbol(ctx context.Context, symbol string) (storage.Asset, error)
}

type CandleStore interface {
	Series(ctx context.Context, assetID int, resolution int16, from, to time.Time, limit int) ([]storage.Candle, error)
	CrossSeries(ctx context.Context, params storage.CrossSeriesParams) ([]storage.CrossPoint, error)
}

type PairStore interface {
	List(ctx context.Context, userID int64) ([]storage.Pair, error)
	Create(ctx context.Context, userID int64, baseAssetID, quoteAssetID int) (int64, error)
	Delete(ctx context.Context, userID, pairID int64) error
	Owned(ctx context.Context, userID, pairID int64) (bool, error)
}

type NotificationStore interface {
	Unseen(ctx context.Context, userID int64) ([]storage.Notification, error)
	MarkSeen(ctx context.Context, userID int64) error
}

type AlertStore interface {
	List(ctx context.Context, userID int64) ([]storage.AlertRule, error)
	Create(ctx context.Context, rule storage.NewAlertRule) (storage.AlertRule, error)
	Update(ctx context.Context, userID, ruleID int64, update storage.AlertUpdate) (storage.AlertRule, error)
	Delete(ctx context.Context, userID, ruleID int64) error
}

// Hub раздаёт котировки реального времени подключённым клиентам.
type Hub interface {
	Subscribe(assets ...int) *stream.Subscriber
	Unsubscribe(sub *stream.Subscriber)
	Snapshot(assetID int) []stream.Point
}

type Deps struct {
	DB            Pinger
	Users         UserStore
	Assets        AssetStore
	Pairs         PairStore
	Candles       CandleStore
	Alerts        AlertStore
	Notifications NotificationStore
	Hub           Hub
	Tokens        TokenIssuer
	Logger        *slog.Logger
}

type Server struct {
	pool          Pinger
	users         UserStore
	assets        AssetStore
	pairs         PairStore
	candles       CandleStore
	alerts        AlertStore
	notifications NotificationStore
	hub           Hub
	tokens        TokenIssuer
	logger        *slog.Logger
}

func NewRouter(d Deps) http.Handler {
	s := &Server{
		pool:          d.DB,
		users:         d.Users,
		assets:        d.Assets,
		pairs:         d.Pairs,
		candles:       d.Candles,
		alerts:        d.Alerts,
		notifications: d.Notifications,
		hub:           d.Hub,
		tokens:        d.Tokens,
		logger:        d.Logger,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /api/auth/register", s.register)
	mux.HandleFunc("POST /api/auth/login", s.login)

	// Справочник активов — общие сведения, он не привязан к пользователю.
	mux.HandleFunc("GET /api/assets", s.listAssets)

	mux.HandleFunc("GET /api/watchlist", s.requireAuth(s.listWatchlist))
	mux.HandleFunc("POST /api/watchlist", s.requireAuth(s.addPair))
	mux.HandleFunc("DELETE /api/watchlist/{id}", s.requireAuth(s.removePair))

	mux.HandleFunc("GET /api/history", s.requireAuth(s.history))

	mux.HandleFunc("GET /api/alerts", s.requireAuth(s.listAlerts))
	mux.HandleFunc("POST /api/alerts", s.requireAuth(s.createAlert))
	mux.HandleFunc("PATCH /api/alerts/{id}", s.requireAuth(s.updateAlert))
	mux.HandleFunc("DELETE /api/alerts/{id}", s.requireAuth(s.deleteAlert))

	mux.HandleFunc("GET /api/notifications", s.requireAuth(s.listNotifications))
	mux.HandleFunc("POST /api/notifications/seen", s.requireAuth(s.markNotificationsSeen))

	mux.HandleFunc("GET /api/stream", s.requireAuth(s.stream))

	return requestLogger(d.Logger)(mux)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := s.pool.Ping(ctx); err != nil {
		s.logger.Error("health check failed", "error", err)
		writeError(w, http.StatusServiceUnavailable, "database is unavailable")
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
