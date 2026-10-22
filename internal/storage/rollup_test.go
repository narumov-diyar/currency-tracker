package storage

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Свёртка целиком лежит в SQL, заглушками её не проверить, поэтому тесты
// работают с настоящей базой.
func insertFullCandle(t *testing.T, pool *pgxpool.Pool, asset int, resolution int,
	at time.Time, open, high, low, closePrice, volume string) {
	t.Helper()

	_, err := pool.Exec(context.Background(), `
		INSERT INTO price_candles (asset_id, resolution, collected_at, open_price,
		                           high_price, low_price, close_price, volume)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		asset, resolution, at, open, high, low, closePrice, volume)
	if err != nil {
		t.Fatalf("insert candle: %v", err)
	}
}

type storedCandle struct {
	At     time.Time
	Open   string
	High   string
	Low    string
	Close  string
	Volume *string
}

func storedCandles(t *testing.T, pool *pgxpool.Pool, asset int, resolution int) []storedCandle {
	t.Helper()

	rows, err := pool.Query(context.Background(), `
		SELECT collected_at, open_price::text, high_price::text, low_price::text,
		       close_price::text, volume::text
		FROM price_candles
		WHERE asset_id = $1 AND resolution = $2
		ORDER BY collected_at`, asset, resolution)
	if err != nil {
		t.Fatalf("read candles: %v", err)
	}
	defer rows.Close()

	var candles []storedCandle
	for rows.Next() {
		var c storedCandle
		if err := rows.Scan(&c.At, &c.Open, &c.High, &c.Low, &c.Close, &c.Volume); err != nil {
			t.Fatalf("scan candle: %v", err)
		}
		candles = append(candles, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read candles: %v", err)
	}
	return candles
}

func bucketStart(at time.Time, step time.Duration) time.Time {
	return at.UTC().Truncate(step)
}

func TestAggregateFoldsPeriod(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	btc := assetID(t, pool, "BTC")

	start := bucketStart(time.Now().Add(-time.Hour), 5*time.Minute)
	insertFullCandle(t, pool, btc, 1, start, "100", "110", "95", "105", "1")
	insertFullCandle(t, pool, btc, 1, start.Add(time.Minute), "105", "130", "90", "120", "2")
	insertFullCandle(t, pool, btc, 1, start.Add(2*time.Minute), "120", "125", "118", "119", "4")
	insertFullCandle(t, pool, btc, 1, start.Add(3*time.Minute), "119", "121", "60", "70", "8")
	insertFullCandle(t, pool, btc, 1, start.Add(4*time.Minute), "70", "80", "65", "75", "16")

	created, err := NewRollups(pool).Aggregate(ctx, 1, 5)
	if err != nil {
		t.Fatalf("aggregate: %v", err)
	}
	if created != 1 {
		t.Fatalf("created %d aggregates, want 1", created)
	}

	// Исходные свечи остаются: их удаляет срок хранения, а не свёртка.
	if left := storedCandles(t, pool, btc, 1); len(left) != 5 {
		t.Errorf("minute candles left: %d, want all 5 kept", len(left))
	}

	folded := storedCandles(t, pool, btc, 5)
	if len(folded) != 1 {
		t.Fatalf("got %d five-minute candles, want 1", len(folded))
	}

	got := folded[0]
	if !got.At.Equal(start) {
		t.Errorf("time = %s, want the period start %s", got.At, start)
	}
	// Открытие — от первой свечи периода, закрытие — от последней,
	// а не минимум с максимумом: 70 меньше 100, и спутать их легко.
	if got.Open != "100.00000000" {
		t.Errorf("open = %s, want 100 from the first candle", got.Open)
	}
	if got.Close != "75.00000000" {
		t.Errorf("close = %s, want 75 from the last candle", got.Close)
	}
	if got.High != "130.00000000" {
		t.Errorf("high = %s, want the maximum 130", got.High)
	}
	if got.Low != "60.00000000" {
		t.Errorf("low = %s, want the minimum 60", got.Low)
	}
	if got.Volume == nil || *got.Volume != "31.00000000" {
		t.Errorf("volume = %v, want the sum 31", got.Volume)
	}
}

// Агрегат нужен сразу после закрытия периода: график за сутки строится
// по пятиминутным свечам, и ждать истечения срока минутных значило бы
// отдавать пустой график за последний месяц.
func TestAggregateCoversFreshHistory(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	btc := assetID(t, pool, "BTC")

	start := bucketStart(time.Now().Add(-2*time.Hour), time.Hour)
	for i := 0; i < 120; i++ {
		insertFullCandle(t, pool, btc, 1, start.Add(time.Duration(i)*time.Minute),
			"100", "100", "100", "100", "1")
	}

	rollups := NewRollups(pool)
	if _, err := rollups.Aggregate(ctx, 1, 5); err != nil {
		t.Fatalf("aggregate to 5m: %v", err)
	}
	if _, err := rollups.Aggregate(ctx, 5, 60); err != nil {
		t.Fatalf("aggregate to 60m: %v", err)
	}

	if got := len(storedCandles(t, pool, btc, 5)); got != 24 {
		t.Errorf("got %d five-minute candles, want 24 for two hours", got)
	}
	if got := len(storedCandles(t, pool, btc, 60)); got != 2 {
		t.Errorf("got %d hourly candles, want 2", got)
	}
}

// Повторный проход не должен ни дублировать агрегаты, ни перестраивать
// готовые: отметка обработанного не даёт просматривать историю заново.
func TestAggregateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	eth := assetID(t, pool, "ETH")
	start := bucketStart(time.Now().Add(-time.Hour), 5*time.Minute)
	for i := 0; i < 5; i++ {
		insertFullCandle(t, pool, eth, 1, start.Add(time.Duration(i)*time.Minute),
			"10", "10", "10", "10", "1")
	}

	rollups := NewRollups(pool)
	if _, err := rollups.Aggregate(ctx, 1, 5); err != nil {
		t.Fatalf("first pass: %v", err)
	}
	first := storedCandles(t, pool, eth, 5)

	created, err := rollups.Aggregate(ctx, 1, 5)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if created != 0 {
		t.Errorf("second pass created %d aggregates, want nothing left to do", created)
	}
	if second := storedCandles(t, pool, eth, 5); len(second) != len(first) {
		t.Errorf("got %d candles after the second pass, want the same %d", len(second), len(first))
	}
}

// Следующий закрытый период подхватывается, хотя предыдущие уже
// обработаны: отметка сдвигается, а не запирает уровень.
func TestAggregateContinuesFromWatermark(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	btc := assetID(t, pool, "BTC")
	first := bucketStart(time.Now().Add(-time.Hour), 5*time.Minute)
	for i := 0; i < 5; i++ {
		insertFullCandle(t, pool, btc, 1, first.Add(time.Duration(i)*time.Minute),
			"10", "10", "10", "10", "1")
	}

	rollups := NewRollups(pool)
	if _, err := rollups.Aggregate(ctx, 1, 5); err != nil {
		t.Fatalf("first pass: %v", err)
	}

	second := first.Add(5 * time.Minute)
	for i := 0; i < 5; i++ {
		insertFullCandle(t, pool, btc, 1, second.Add(time.Duration(i)*time.Minute),
			"20", "20", "20", "20", "1")
	}

	created, err := rollups.Aggregate(ctx, 1, 5)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	if created != 1 {
		t.Fatalf("created %d aggregates, want the one new period", created)
	}

	folded := storedCandles(t, pool, btc, 5)
	if len(folded) != 2 {
		t.Fatalf("got %d five-minute candles, want 2", len(folded))
	}
	if folded[1].Close != "20.00000000" {
		t.Errorf("second candle closes at %s, want 20", folded[1].Close)
	}
}

// Незакрытый период не сворачивается: он ещё наполняется, а исправить
// записанную свечу потом нельзя — совпадение по времени отсекается
// уникальным ключом.
func TestAggregateSkipsOpenPeriod(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	sol := assetID(t, pool, "SOL")

	current := bucketStart(time.Now().UTC(), 5*time.Minute)
	insertFullCandle(t, pool, sol, 1, current, "1", "1", "1", "1", "1")

	closed := current.Add(-5 * time.Minute)
	for i := 0; i < 5; i++ {
		insertFullCandle(t, pool, sol, 1, closed.Add(time.Duration(i)*time.Minute),
			"3", "3", "3", "3", "1")
	}

	created, err := NewRollups(pool).Aggregate(ctx, 1, 5)
	if err != nil {
		t.Fatalf("aggregate: %v", err)
	}
	if created != 1 {
		t.Fatalf("created %d aggregates, want only the closed period", created)
	}

	folded := storedCandles(t, pool, sol, 5)
	if len(folded) != 1 || !folded[0].At.Equal(closed) {
		t.Errorf("aggregates = %+v, want a single one at %s", folded, closed)
	}
}

// Свечи разных активов в одном периоде сворачиваются по отдельности:
// группировка идёт по активу, а не только по времени.
func TestAggregateKeepsAssetsApart(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	btc, eth := assetID(t, pool, "BTC"), assetID(t, pool, "ETH")
	start := bucketStart(time.Now().Add(-time.Hour), 5*time.Minute)

	insertFullCandle(t, pool, btc, 1, start, "100", "100", "100", "100", "1")
	insertFullCandle(t, pool, btc, 1, start.Add(time.Minute), "101", "101", "101", "101", "1")
	insertFullCandle(t, pool, eth, 1, start, "10", "10", "10", "10", "1")
	insertFullCandle(t, pool, eth, 1, start.Add(time.Minute), "11", "11", "11", "11", "1")

	created, err := NewRollups(pool).Aggregate(ctx, 1, 5)
	if err != nil {
		t.Fatalf("aggregate: %v", err)
	}
	if created != 2 {
		t.Fatalf("created %d aggregates, want one per asset", created)
	}

	if got := storedCandles(t, pool, btc, 5); len(got) != 1 || got[0].Close != "101.00000000" {
		t.Errorf("BTC aggregate = %+v, want a single candle closing at 101", got)
	}
	if got := storedCandles(t, pool, eth, 5); len(got) != 1 || got[0].Close != "11.00000000" {
		t.Errorf("ETH aggregate = %+v, want a single candle closing at 11", got)
	}
}

// Срок хранения удаляет только своё разрешение: укрупнённые свечи за тот
// же отрезок времени должны остаться, иначе понижение детализации
// превратилось бы в потерю истории.
func TestPruneRemovesOnlyExpiredResolution(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	btc := assetID(t, pool, "BTC")
	old := bucketStart(time.Now().Add(-60*24*time.Hour), 5*time.Minute)
	fresh := bucketStart(time.Now().Add(-time.Hour), 5*time.Minute)

	insertFullCandle(t, pool, btc, 1, old, "1", "1", "1", "1", "1")
	insertFullCandle(t, pool, btc, 1, fresh, "2", "2", "2", "2", "1")
	insertFullCandle(t, pool, btc, 5, old, "1", "1", "1", "1", "1")

	removed, err := NewRollups(pool).Prune(ctx, 1, 30)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if removed != 1 {
		t.Fatalf("removed %d rows, want only the expired minute candle", removed)
	}

	left := storedCandles(t, pool, btc, 1)
	if len(left) != 1 || !left[0].At.Equal(fresh) {
		t.Errorf("minute candles = %+v, want only the fresh one", left)
	}
	if got := storedCandles(t, pool, btc, 5); len(got) != 1 {
		t.Errorf("got %d five-minute candles, want the aggregate kept", len(got))
	}
}

func TestPruneKeepsEverythingWithinRetention(t *testing.T) {
	ctx := context.Background()
	pool := testPool(t)
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	eth := assetID(t, pool, "ETH")
	for i := 1; i <= 3; i++ {
		insertFullCandle(t, pool, eth, 1,
			bucketStart(time.Now().Add(-time.Duration(i)*time.Hour), time.Minute),
			"1", "1", "1", "1", "1")
	}

	removed, err := NewRollups(pool).Prune(ctx, 1, 30)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if removed != 0 {
		t.Errorf("removed %d rows, want none within the retention window", removed)
	}
	if got := len(storedCandles(t, pool, eth, 1)); got != 3 {
		t.Errorf("got %d candles left, want all 3", got)
	}
}
