package stream

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TickChannel — канал уведомлений PostgreSQL, в который сборщик шлёт
// текущие котировки. Эти значения в базу не записываются: они живут
// только в памяти сервера, ради чего канал и выбран вместо таблицы.
const TickChannel = "ticks"

type tickEvent struct {
	AssetID int    `json:"asset_id"`
	Symbol  string `json:"symbol"`
	Price   string `json:"price"`
	TS      int64  `json:"ts"`
}

type Listener struct {
	pool   *pgxpool.Pool
	hub    *Hub
	logger *slog.Logger
}

func NewListener(pool *pgxpool.Pool, hub *Hub, logger *slog.Logger) *Listener {
	return &Listener{pool: pool, hub: hub, logger: logger}
}

func (l *Listener) Run(ctx context.Context) {
	const retryDelay = 5 * time.Second

	for {
		if err := l.listen(ctx); err != nil && !errors.Is(err, context.Canceled) {
			l.logger.Error("tick listener stopped", "error", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(retryDelay):
		}
	}
}

// listen удерживает отдельное соединение: подписка LISTEN действует
// в его пределах, и возврат соединения в пул означал бы её потерю.
func (l *Listener) listen(ctx context.Context) error {
	conn, err := l.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "LISTEN "+TickChannel); err != nil {
		return err
	}
	l.logger.Info("tick listener started", "channel", TickChannel)

	for {
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}

		var event tickEvent
		if err := json.Unmarshal([]byte(notification.Payload), &event); err != nil {
			l.logger.Error("malformed tick event", "payload", notification.Payload)
			continue
		}

		l.hub.Publish(Tick{
			AssetID: event.AssetID,
			Symbol:  event.Symbol,
			Price:   event.Price,
			At:      event.TS,
		})
	}
}
