package devdata

import (
	"math/rand"
	"testing"
	"time"
)

func TestGenerateProducesConsistentCandles(t *testing.T) {
	asset := Asset{ID: 1, Symbol: "BTC", ResolutionSeconds: 60}
	candles := Generate(asset, time.Hour, time.Now().UTC(), rand.New(rand.NewSource(1)))

	if len(candles) != 60 {
		t.Fatalf("got %d candles, want 60", len(candles))
	}

	for i, c := range candles {
		if c.Low > c.Open || c.Low > c.Close {
			t.Fatalf("candle %d: low %v is above open %v or close %v", i, c.Low, c.Open, c.Close)
		}
		if c.High < c.Open || c.High < c.Close {
			t.Fatalf("candle %d: high %v is below open %v or close %v", i, c.High, c.Open, c.Close)
		}
		if c.Low <= 0 {
			t.Fatalf("candle %d: low must stay positive, got %v", i, c.Low)
		}
		if c.Resolution != 1 {
			t.Fatalf("candle %d: resolution = %d, want 1", i, c.Resolution)
		}
	}
}

func TestGenerateIsOrderedAndSpacedByResolution(t *testing.T) {
	asset := Asset{ID: 2, Symbol: "RUB", ResolutionSeconds: 86400}
	candles := Generate(asset, 10*24*time.Hour, time.Now().UTC(), rand.New(rand.NewSource(7)))

	if len(candles) != 10 {
		t.Fatalf("got %d candles, want 10", len(candles))
	}
	if candles[0].Resolution != 1440 {
		t.Errorf("resolution = %d, want 1440", candles[0].Resolution)
	}

	for i := 1; i < len(candles); i++ {
		gap := candles[i].CollectedAt.Sub(candles[i-1].CollectedAt)
		if gap != 24*time.Hour {
			t.Fatalf("gap between candles %d and %d is %v, want 24h", i-1, i, gap)
		}
	}

	// Фиатные курсы объёма не имеют: сборщик получает только сам курс.
	if candles[0].Volume != 0 || candles[0].Turnover != 0 {
		t.Error("fiat candles must not carry volume or turnover")
	}
}

func TestGenerateIsReproducible(t *testing.T) {
	asset := Asset{ID: 1, Symbol: "ETH", ResolutionSeconds: 60}
	now := time.Now().UTC()

	first := Generate(asset, time.Hour, now, rand.New(rand.NewSource(42)))
	second := Generate(asset, time.Hour, now, rand.New(rand.NewSource(42)))

	for i := range first {
		if first[i] != second[i] {
			t.Fatalf("candle %d differs between runs with the same seed", i)
		}
	}
}

func TestGenerateRejectsBadInput(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))

	if got := Generate(Asset{ID: 1, Symbol: "BTC"}, time.Hour, time.Now(), rnd); got != nil {
		t.Errorf("zero resolution must yield no candles, got %d", len(got))
	}
	if got := Generate(Asset{ID: 1, Symbol: "BTC", ResolutionSeconds: 60}, time.Second, time.Now(), rnd); got != nil {
		t.Errorf("span shorter than the step must yield no candles, got %d", len(got))
	}
}

// Цены выражены в USDT, поэтому цена самого USDT равна единице: блуждание
// увело бы пару BTC/USDT от цены биткойна.
func TestGenerateKeepsQuoteAssetAtOne(t *testing.T) {
	asset := Asset{ID: 1, Symbol: QuoteSymbol, ResolutionSeconds: 60}
	candles := Generate(asset, 48*time.Hour, time.Now(), rand.New(rand.NewSource(7)))

	if len(candles) == 0 {
		t.Fatal("ряд пуст")
	}
	for _, c := range candles {
		if c.Open != 1 || c.High != 1 || c.Low != 1 || c.Close != 1 {
			t.Fatalf("свеча %v: цены %g/%g/%g/%g, ожидалась единица во всех четырёх",
				c.CollectedAt, c.Open, c.High, c.Low, c.Close)
		}
	}
}
