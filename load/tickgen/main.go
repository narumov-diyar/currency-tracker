// tickgen имитирует биржу на изолированном нагрузочном стенде.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
)

type tick struct {
	ID     int    `json:"asset_id"`
	Symbol string `json:"symbol"`
	Price  string `json:"price"`
	At     int64  `json:"ts"`
}

func run(ctx context.Context) error {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	symbols := []string{"BTC", "ETH", "SOL", "BNB", "ADA", "XRP", "DOGE", "LTC"}
	rows, err := conn.Query(ctx, "SELECT id, symbol FROM assets WHERE symbol = ANY($1) ORDER BY symbol", symbols)
	if err != nil {
		return err
	}
	assets, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (tick, error) {
		var asset tick
		err := row.Scan(&asset.ID, &asset.Symbol)
		return asset, err
	})
	if err != nil {
		return err
	}
	if len(assets) != len(symbols) {
		return fmt.Errorf("expected %d assets, found %d", len(symbols), len(assets))
	}

	timer := time.NewTicker(50 * time.Millisecond)
	defer timer.Stop()
	report := time.NewTicker(10 * time.Second)
	defer report.Stop()
	batches := 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-report.C:
			log.Printf("batches in 10s: %d (%d ticks/batch)", batches, len(assets))
			batches = 0
		case <-timer.C:
			at := time.Now().UnixMilli()
			payloads := make([]string, 0, len(assets))
			for i, asset := range assets {
				asset.Price = fmt.Sprintf("%d.%02d", 100+i, at%100)
				asset.At = at
				value, err := json.Marshal(asset)
				if err != nil {
					return err
				}
				payloads = append(payloads, string(value))
			}
			if _, err := conn.Exec(ctx, "SELECT pg_notify('ticks', payload) FROM unnest($1::text[]) AS payload", payloads); err != nil {
				return err
			}
			batches++
		}
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil && ctx.Err() == nil {
		log.Fatal(err)
	}
}
