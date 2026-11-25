package storage

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Запрос списка — самое сложное место: боковые соединения, вычисление курса
// в numeric и признак устаревания по разрешению актива. Заглушками это
// не проверить, поэтому тест работает с настоящей базой.
func seedUser(t *testing.T, pool *pgxpool.Pool, email string) int64 {
	t.Helper()

	var id int64
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (email, password_hash) VALUES ($1, 'hash') RETURNING id`, email).Scan(&id)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

func assetID(t *testing.T, pool *pgxpool.Pool, symbol string) int {
	t.Helper()

	var id int
	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM assets WHERE symbol = $1`, symbol).Scan(&id); err != nil {
		t.Fatalf("read asset %s: %v", symbol, err)
	}
	return id
}

func insertCandle(t *testing.T, pool *pgxpool.Pool, asset int, resolution int, at time.Time, close string) {
	t.Helper()

	_, err := pool.Exec(context.Background(), `
		INSERT INTO price_candles (asset_id, resolution, collected_at, open_price, high_price, low_price, close_price)
		VALUES ($1, $2, $3, $4, $4, $4, $4)`, asset, resolution, at, close)
	if err != nil {
		t.Fatalf("insert candle: %v", err)
	}
}

func TestPairsListComputesRate(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	userID := seedUser(t, pool, "rate@example.com")
	btc, usdt := assetID(t, pool, "BTC"), assetID(t, pool, "USDT")

	now := time.Now().UTC().Truncate(time.Minute)
	insertCandle(t, pool, btc, 1, now.Add(-2*time.Minute), "60000")
	insertCandle(t, pool, btc, 1, now, "63000.5")
	insertCandle(t, pool, usdt, 1, now, "1")

	pairs := NewPairs(pool)
	if _, err := pairs.Create(ctx, userID, btc, usdt); err != nil {
		t.Fatalf("create pair: %v", err)
	}

	list, err := pairs.List(ctx, userID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("got %d pairs, want 1", len(list))
	}

	got := list[0]
	if got.Base.Symbol != "BTC" || got.Quote.Symbol != "USDT" {
		t.Errorf("pair = %s/%s, want BTC/USDT", got.Base.Symbol, got.Quote.Symbol)
	}
	if got.Rate == nil {
		t.Fatal("rate must be computed when both sides have candles")
	}
	// Берётся последняя свеча, а не первая попавшаяся.
	if *got.Rate != "63000.50000000" {
		t.Errorf("rate = %s, want 63000.50000000", *got.Rate)
	}
	if got.Stale {
		t.Error("fresh candles must not be marked stale")
	}
}

func TestPairsListMarksStaleAndMissingData(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	userID := seedUser(t, pool, "stale@example.com")
	btc, usdt := assetID(t, pool, "BTC"), assetID(t, pool, "USDT")
	eth := assetID(t, pool, "ETH")

	now := time.Now().UTC().Truncate(time.Minute)
	// Минутный актив считается устаревшим после двух интервалов, то есть двух минут.
	insertCandle(t, pool, btc, 1, now.Add(-10*time.Minute), "60000")
	insertCandle(t, pool, usdt, 1, now, "1")

	pairs := NewPairs(pool)
	if _, err := pairs.Create(ctx, userID, btc, usdt); err != nil {
		t.Fatalf("create stale pair: %v", err)
	}
	// У этой пары котировок нет вовсе.
	if _, err := pairs.Create(ctx, userID, eth, usdt); err != nil {
		t.Fatalf("create empty pair: %v", err)
	}

	list, err := pairs.List(ctx, userID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d pairs, want 2", len(list))
	}

	if !list[0].Stale {
		t.Error("a pair whose side lags behind must be marked stale")
	}
	if list[1].Rate != nil {
		t.Errorf("rate = %v, want nothing without candles", *list[1].Rate)
	}
	if !list[1].Stale {
		t.Error("a pair without candles must be marked stale")
	}
}

func TestPairsListIsolatesUsers(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	first := seedUser(t, pool, "first@example.com")
	second := seedUser(t, pool, "second@example.com")
	btc, usdt := assetID(t, pool, "BTC"), assetID(t, pool, "USDT")

	pairs := NewPairs(pool)
	pairID, err := pairs.Create(ctx, first, btc, usdt)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Та же пара у другого пользователя — не дубль: уникальность в пределах списка.
	if _, err := pairs.Create(ctx, second, btc, usdt); err != nil {
		t.Fatalf("the same pair must be allowed for another user: %v", err)
	}
	if _, err := pairs.Create(ctx, first, btc, usdt); err != ErrPairExists {
		t.Errorf("err = %v, want ErrPairExists", err)
	}

	if err := pairs.Delete(ctx, second, pairID); err != ErrPairNotFound {
		t.Errorf("deleting another user's pair: err = %v, want ErrPairNotFound", err)
	}

	list, err := pairs.List(ctx, second)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("second user sees %d pairs, want only their own", len(list))
	}
}

// Удаление пары не должно затрагивать общую историю котировок.
func TestDeletePairKeepsCandles(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	userID := seedUser(t, pool, "keep@example.com")
	btc, usdt := assetID(t, pool, "BTC"), assetID(t, pool, "USDT")
	insertCandle(t, pool, btc, 1, time.Now().UTC().Truncate(time.Minute), "63000")

	pairs := NewPairs(pool)
	pairID, err := pairs.Create(ctx, userID, btc, usdt)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := pairs.Delete(ctx, userID, pairID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	var candles int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM price_candles WHERE asset_id = $1`, btc).Scan(&candles); err != nil {
		t.Fatalf("count candles: %v", err)
	}
	if candles != 1 {
		t.Errorf("candles = %d, want them untouched after removing a pair", candles)
	}
}

func TestPairFreshnessUsesEachAssetsInterval(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for _, tc := range []struct {
		name, base, quote string
		baseAge, quoteAge time.Duration
		stale             bool
	}{
		{"crypto fresh", "BTC", "USDT", time.Minute, time.Minute, false},
		{"crypto stale", "BTC", "USDT", time.Minute, 3 * time.Minute, true},
		{"fiat fresh", "EUR", "RUB", 25 * time.Hour, 25 * time.Hour, false},
		{"fiat stale", "EUR", "RUB", 25 * time.Hour, 49 * time.Hour, true},
		{"mixed fresh", "BTC", "RUB", time.Minute, 25 * time.Hour, false},
		{"mixed stale", "BTC", "RUB", 3 * time.Minute, 25 * time.Hour, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, "DELETE FROM price_candles"); err != nil {
				t.Fatal(err)
			}
			base, quote := assetID(t, pool, tc.base), assetID(t, pool, tc.quote)
			for _, side := range []struct {
				symbol string
				id     int
				age    time.Duration
			}{{tc.base, base, tc.baseAge}, {tc.quote, quote, tc.quoteAge}} {
				resolution := 1
				if side.symbol == "EUR" || side.symbol == "RUB" {
					resolution = 1440
				}
				insertCandle(t, pool, side.id, resolution, now.Add(-side.age), "10")
			}
			user := seedUser(t, pool, tc.name+"@example.com")
			if _, err := pool.Exec(ctx, "INSERT INTO user_pairs (user_id,base_asset_id,quote_asset_id) VALUES ($1,$2,$3)", user, base, quote); err != nil {
				t.Fatal(err)
			}
			pairs, err := NewPairs(pool).List(ctx, user)
			if err != nil || len(pairs) != 1 || pairs[0].Rate == nil || pairs[0].Stale != tc.stale {
				t.Fatalf("pair=%+v err=%v, want a rate and stale=%t", pairs, err, tc.stale)
			}
		})
	}
}
