package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/narumov-diyar/currency-tracker/internal/storage"
	"github.com/narumov-diyar/currency-tracker/internal/stream"
)

// Клиент получает не более одного сообщения в секунду: обновлять график
// чаще незачем, а поток биржи приходит в двадцать раз плотнее.
const tickInterval = time.Second

type snapshotMessage struct {
	Type   string  `json:"type"`
	Symbol string  `json:"symbol"`
	Points [][]any `json:"points"`
}

type tickMessage struct {
	Type  string        `json:"type"`
	Ticks []stream.Tick `json:"ticks"`
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	base, ok := s.resolveAsset(w, r, upper(query.Get("base")))
	if !ok {
		return
	}
	quote, ok := s.resolveAsset(w, r, upper(query.Get("quote")))
	if !ok {
		return
	}

	// Подписка оформляется только на стороны, умеющие потоковый режим:
	// у фиатной валюты котировок внутри суток просто нет.
	watched := make([]int, 0, 2)
	assets := make([]storage.Asset, 0, 2)
	for _, asset := range []storage.Asset{base, quote} {
		if asset.SupportsRealtime {
			watched = append(watched, asset.ID)
			assets = append(assets, asset)
		}
	}
	if len(watched) == 0 {
		writeError(w, http.StatusBadRequest, "neither side of the pair supports the realtime mode")
		return
	}

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		s.logger.Error("websocket accept", "error", err)
		return
	}
	defer conn.CloseNow()

	ctx := r.Context()
	sub := s.hub.Subscribe(watched...)
	// Подписка снимается в любом случае: по ней сборщик решает, какие
	// активы продолжать слушать на бирже.
	defer s.hub.Unsubscribe(sub)

	if err := s.sendSnapshots(ctx, conn, assets); err != nil {
		return
	}

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// За секунду могло прийти много котировок, но наружу уходит
			// только последняя по каждому активу.
			ticks := sub.Drain()
			if len(ticks) == 0 {
				continue
			}
			if err := wsjson.Write(ctx, conn, tickMessage{Type: "tick", Ticks: ticks}); err != nil {
				return
			}
		}
	}
}

// sendSnapshots отдаёт накопленное окно сразу при подключении, чтобы
// клиент увидел график целиком, а не ждал первой новой котировки.
func (s *Server) sendSnapshots(ctx context.Context, conn *websocket.Conn, assets []storage.Asset) error {
	for _, asset := range assets {
		points := s.hub.Snapshot(asset.ID)

		rows := make([][]any, 0, len(points))
		for _, p := range points {
			rows = append(rows, []any{p.At.UnixMilli(), p.Price})
		}

		message := snapshotMessage{Type: "snapshot", Symbol: asset.Symbol, Points: rows}
		if err := wsjson.Write(ctx, conn, message); err != nil {
			return err
		}
	}
	return nil
}
