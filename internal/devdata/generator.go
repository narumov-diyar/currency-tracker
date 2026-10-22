// Пакет devdata порождает синтетические ряды котировок для разработки.
// Данные неотличимы по форме от собираемых сборщиком, но внешние источники
// не опрашиваются: ряд строится случайным блужданием.
package devdata

import (
	"math"
	"math/rand"
	"time"
)

type Asset struct {
	ID                int
	Symbol            string
	ResolutionSeconds int
}

type Candle struct {
	AssetID     int
	Resolution  int16
	CollectedAt time.Time
	Open        float64
	High        float64
	Low         float64
	Close       float64
	Volume      float64
	Turnover    float64
}

// QuoteSymbol — актив, в котором выражены цены всех остальных. Его
// собственная цена равна единице по определению, поэтому ряд для него
// не блуждает: иначе пара BTC/USDT расходилась бы с ценой биткойна.
const QuoteSymbol = "USDT"

// startPrice задаёт правдоподобный порядок величины: без этого все активы
// стартовали бы с одной цены и графики выглядели бы одинаково.
//
// Цена всегда означает «сколько USDT стоит одна единица актива». Для фиатных
// валют это обратная величина привычного курса: источник отдаёт «рублей за
// доллар» (около 84), а хранить нужно 1/84. Без этого пересчёта кросс-курс
// пары из криптовалюты и фиата получается перевёрнутым.
var startPrice = map[string]float64{
	"USDT": 1,
	"BTC":  63000,
	"ETH":  2500,
	"SOL":  140,
	"BNB":  580,
	"XRP":  0.52,
	"DOGE": 0.12,
	"USD":  1,
	"EUR":  1.0 / 0.92,
	"RUB":  1.0 / 84,
	"KZT":  1.0 / 447,
	"CNY":  1.0 / 7.1,
	"TRY":  1.0 / 34,
	"GBP":  1.0 / 0.77,
	"JPY":  1.0 / 150,
	"AED":  1.0 / 3.67,
	"BYN":  1.0 / 3.27,
}

// Generate строит ряд свечей, заканчивающийся в now и покрывающий период span.
// Шаг ряда берётся из разрешения актива, поэтому фиатные валюты получают
// дневные свечи, а криптовалюты — минутные.
func Generate(asset Asset, span time.Duration, now time.Time, rnd *rand.Rand) []Candle {
	step := time.Duration(asset.ResolutionSeconds) * time.Second
	if step <= 0 {
		return nil
	}

	count := int(span / step)
	if count <= 0 {
		return nil
	}

	price := startPrice[asset.Symbol]
	if price == 0 {
		price = 10 + rnd.Float64()*90
	}

	// Фиатные курсы колеблются слабее криптовалютных, иначе рубль
	// на графике вёл бы себя как мем-монета.
	volatility := 0.0015
	switch {
	case asset.Symbol == QuoteSymbol:
		volatility = 0
	case asset.ResolutionSeconds >= 86400:
		volatility = 0.004
	}

	// Ряд строится от конца к началу, поэтому стартовая цена задаёт
	// последнюю свечу, а не первую.
	start := now.Add(-span).Truncate(step)
	candles := make([]Candle, 0, count)

	for i := 0; i < count; i++ {
		open := price
		price *= 1 + rnd.NormFloat64()*volatility
		if price <= 0 {
			price = open
		}
		close := price

		spread := math.Abs(rnd.NormFloat64()) * volatility * open
		high := math.Max(open, close) + spread
		low := math.Min(open, close) - spread
		if low <= 0 {
			low = math.Min(open, close) / 2
		}

		candle := Candle{
			AssetID:     asset.ID,
			Resolution:  int16(asset.ResolutionSeconds / 60),
			CollectedAt: start.Add(time.Duration(i) * step),
			Open:        open,
			High:        high,
			Low:         low,
			Close:       close,
		}

		// Для фиатных курсов объём торгов не публикуется, поэтому остаётся пустым.
		if asset.ResolutionSeconds < 86400 {
			candle.Volume = math.Abs(rnd.NormFloat64()) * 50
			candle.Turnover = candle.Volume * close
		}

		candles = append(candles, candle)
	}

	return candles
}
