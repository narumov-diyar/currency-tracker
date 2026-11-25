package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/narumov-diyar/currency-tracker/internal/stream"
)

func TestPostgresTicksReachWebSocket(t *testing.T) {
	env := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	listenerCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		stream.NewListener(env.pool, env.hub, logger).Run(listenerCtx)
	}()
	defer func() { stop(); <-done }()

	var registered struct{ Token string }
	env.do(t, http.MethodPost, "/api/auth/register", "",
		map[string]string{"email": "notify@example.com", "password": "safe-password"},
		http.StatusCreated, &registered)

	publisher, err := env.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Release()
	btc, usdt := env.assetID(t, "BTC"), env.assetID(t, "USDT")
	at := time.Now().UnixMilli()
	payload := func(price string, ts int64) string {
		t.Helper()
		data, err := json.Marshal(map[string]any{"asset_id": btc, "symbol": "BTC", "price": price, "ts": ts})
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	notify := func(value string) {
		t.Helper()
		if _, err := publisher.Exec(ctx, "SELECT pg_notify($1, $2)", stream.TickChannel, value); err != nil {
			t.Fatal(err)
		}
	}
	candleCount := func() int {
		t.Helper()
		var n int
		if err := publisher.QueryRow(ctx, "SELECT count(*) FROM price_candles").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before := candleCount()

	// Дожидаемся именно работы LISTEN: пробная котировка должна попасть в Hub.
	pollTickStream(t, ctx, "listener ready", func() bool {
		if len(env.hub.Snapshot(btc)) != 0 {
			return true
		}
		notify(payload("100.25", at))
		return false
	})
	url := "ws" + strings.TrimPrefix(env.server.URL, "http") + "/api/stream?base=BTC&quote=USDT&token=" + registered.Token
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	pollTickStream(t, ctx, "subscribe", func() bool {
		return env.hub.SubscriberCount(btc) == 1 && env.hub.SubscriberCount(usdt) == 1
	})

	type message struct {
		Type   string
		Symbol string
		Points [][]json.RawMessage
		Ticks  []stream.Tick
	}
	read := func() message {
		t.Helper()
		var got message
		if err := wsjson.Read(ctx, conn, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	first, second := read(), read()
	if first.Type != "snapshot" || first.Symbol != "BTC" || len(first.Points) != 1 ||
		second.Type != "snapshot" || second.Symbol != "USDT" {
		t.Fatalf("unexpected snapshots: %+v / %+v", first, second)
	}
	if len(first.Points[0]) != 2 || string(first.Points[0][0]) != fmt.Sprint(at) || string(first.Points[0][1]) != `"100.25"` {
		t.Fatalf("snapshot point: %s", first.Points[0])
	}

	notify(payload("101.25", at+1))
	initial := read()
	if initial.Type != "tick" || len(initial.Ticks) != 1 {
		t.Fatalf("unexpected initial tick %+v", initial)
	}
	if tick := initial.Ticks[0]; tick.Symbol != "BTC" || tick.Price != "101.25" || tick.At != at+1 {
		t.Fatalf("unexpected tick %+v", tick)
	}

	// Начинаем сразу после отправки, чтобы десять событий попали в один
	// интервал. PostgreSQL доставляет их по порядку при завершении запроса.
	burst := []string{"{"}
	for i := range 10 {
		burst = append(burst, payload(fmt.Sprint(200+i), at+2+int64(i)))
	}
	if _, err := publisher.Exec(ctx, "SELECT pg_notify($1, value) FROM unnest($2::text[]) AS value", stream.TickChannel, burst); err != nil {
		t.Fatal(err)
	}
	next := read()
	if next.Type != "tick" || len(next.Ticks) != 1 {
		t.Fatalf("unexpected burst result %+v", next)
	}
	if tick := next.Ticks[0]; tick.Symbol != "BTC" || tick.Price != "209" || tick.At != at+11 {
		t.Fatalf("expected last tick after an invalid payload, got %+v", tick)
	}
	if after := candleCount(); before != after {
		t.Errorf("stream changed price_candles count: %d -> %d", before, after)
	}
	if err := conn.CloseNow(); err != nil {
		t.Fatal(err)
	}
	pollTickStream(t, ctx, "unsubscribe", func() bool {
		return env.hub.SubscriberCount(btc) == 0 && env.hub.SubscriberCount(usdt) == 0
	})
}

func pollTickStream(t *testing.T, ctx context.Context, condition string, ready func() bool) {
	t.Helper()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	for !ready() {
		select {
		case <-ctx.Done():
			t.Fatalf("%s: %v", condition, ctx.Err())
		case <-poll.C:
		}
	}
}
