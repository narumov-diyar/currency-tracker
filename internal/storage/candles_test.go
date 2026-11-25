package storage

import (
	"context"
	"testing"
	"time"
)

func TestCandlesSeriesFiltersAndKeepsNewest(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	btc, eth := assetID(t, pool, "BTC"), assetID(t, pool, "ETH")
	from := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	to := from.Add(3 * time.Minute)
	for _, minute := range []int{2, -1, 3, 0, 1} {
		insertCandle(t, pool, btc, 1, from.Add(time.Duration(minute)*time.Minute), "100")
	}
	insertCandle(t, pool, btc, 5, from, "999")
	insertCandle(t, pool, eth, 1, from, "999")

	candles := NewCandles(pool)
	assertSeries := func(limit, first, size int) {
		t.Helper()
		got, err := candles.Series(ctx, btc, 1, from, to, limit)
		if err != nil || len(got) != size {
			t.Fatalf("limit %d: %d candles, err=%v, want %d", limit, len(got), err, size)
		}
		for i, candle := range got {
			want := from.Add(time.Duration(first+i) * time.Minute)
			if !candle.CollectedAt.Equal(want) || candle.Close != "100.00000000" {
				t.Errorf("candle %d = %+v, want %v at price 100", i, candle, want)
			}
		}
	}
	assertSeries(10, 0, 3)
	assertSeries(2, 1, 2)
	if got, err := candles.Series(ctx, btc, 1, to.Add(time.Minute), to.Add(2*time.Minute), 10); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty window: %v, %v", got, err)
	}
}
