package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/narumov-diyar/currency-tracker/internal/alerts"
	"github.com/narumov-diyar/currency-tracker/internal/auth"
	"github.com/narumov-diyar/currency-tracker/internal/config"
	"github.com/narumov-diyar/currency-tracker/internal/httpapi"
	"github.com/narumov-diyar/currency-tracker/internal/storage"
	"github.com/narumov-diyar/currency-tracker/internal/stream"
)

// Срок жизни сессионного токена.
const tokenTTL = 24 * time.Hour

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	if err := run(logger); err != nil {
		logger.Error("api stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Контекст закрывается по сигналу остановки и служит признаком завершения работы.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		return err
	}

	applied, err := storage.Migrate(ctx, pool)
	if err != nil {
		return err
	}
	if len(applied) > 0 {
		logger.Info("migrations applied", "versions", applied)
	}

	hub := stream.NewHub(stream.DefaultSize)
	go stream.NewListener(pool, hub, logger).Run(ctx)

	alertStore := storage.NewAlerts(pool)
	go alerts.NewListener(pool, alerts.NewService(alertStore, logger), logger).Run(ctx)

	router := httpapi.NewRouter(httpapi.Deps{
		DB:            pool,
		Users:         storage.NewUsers(pool),
		Assets:        storage.NewAssets(pool),
		Pairs:         storage.NewPairs(pool),
		Candles:       storage.NewCandles(pool),
		Alerts:        storage.NewAlerts(pool),
		Notifications: storage.NewNotifications(pool),
		Hub:           hub,
		Tokens:        auth.NewTokenIssuer(cfg.AuthSecret, tokenTTL),
		Logger:        logger,
	})

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	listenErr := make(chan error, 1)
	go func() {
		logger.Info("api started", "addr", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
		}
	}()

	select {
	case err := <-listenErr:
		return err
	case <-ctx.Done():
	}

	// Контекст сигналов уже отменён, поэтому ожидание активных запросов ведём по отдельному.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()

	logger.Info("api shutting down")
	return srv.Shutdown(shutdownCtx)
}
