// Пакет rollup ведёт уровни детализации истории котировок: строит
// укрупнённые свечи из мелких и удаляет вышедшие за свой срок.
//
// Уровни существуют одновременно и перекрываются по времени: минутные свечи
// нужны графику за час, пятиминутные — за сутки, часовые — за неделю.
// Поэтому каждый уровень ведётся непрерывно, а не появляется тогда, когда
// предыдущий доживает до удаления; храниться же уровни должны разное время.
package rollup

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// Tier описывает уровень детализации. From, равный нулю, означает, что
// уровень пишет сборщик и строить его не нужно.
type Tier struct {
	Resolution    int16
	From          int16
	RetentionDays int
}

// Сроки взяты от глубины окон графика: минутная детализация нужна в пределах
// месяца, пятиминутная перекрывает сутки, часовая — неделю. Суточные свечи
// держатся десять лет, чем и выполняется требование хранить историю дольше
// пяти лет.
var DefaultTiers = []Tier{
	{Resolution: 1, From: 0, RetentionDays: 30},
	{Resolution: 5, From: 1, RetentionDays: 90},
	{Resolution: 60, From: 5, RetentionDays: 730},
	{Resolution: 1440, From: 60, RetentionDays: 3650},
}

var allowedResolutions = map[int16]bool{1: true, 5: true, 60: true, 1440: true}

type Store interface {
	Aggregate(ctx context.Context, from, to int16) (int, error)
	Prune(ctx context.Context, resolution int16, days int) (int, error)
}

type Service struct {
	store  Store
	tiers  []Tier
	logger *slog.Logger
}

func NewService(store Store, tiers []Tier, logger *slog.Logger) *Service {
	return &Service{store: store, tiers: tiers, logger: logger}
}

// Validate ловит две ошибки в наборе уровней, которые сами по себе не вызвали
// бы отказа: разрыв в цепочке оставит разрешение, которое никто не строит,
// то есть пустой график на этом периоде, а убывающий срок хранения удалит
// агрегат раньше данных, из которых он построен.
func Validate(tiers []Tier) error {
	if len(tiers) == 0 {
		return fmt.Errorf("rollup: уровни не заданы")
	}
	if tiers[0].From != 0 {
		return fmt.Errorf("rollup: первый уровень %d строится из %d, а должен приходить от сборщика",
			tiers[0].Resolution, tiers[0].From)
	}

	for i, tier := range tiers {
		if !allowedResolutions[tier.Resolution] {
			return fmt.Errorf("rollup: разрешение %d вне допустимых", tier.Resolution)
		}
		if tier.RetentionDays <= 0 {
			return fmt.Errorf("rollup: разрешение %d: срок хранения должен быть положительным", tier.Resolution)
		}
		if i == 0 {
			continue
		}

		previous := tiers[i-1]
		if tier.From != previous.Resolution {
			return fmt.Errorf("rollup: разрешение %d строится из %d, а предыдущий уровень — %d",
				tier.Resolution, tier.From, previous.Resolution)
		}
		if tier.Resolution <= previous.Resolution {
			return fmt.Errorf("rollup: разрешение %d не укрупняет шаг предыдущего уровня %d",
				tier.Resolution, previous.Resolution)
		}
		if tier.RetentionDays <= previous.RetentionDays {
			return fmt.Errorf("rollup: разрешение %d хранится %d суток, не дольше предыдущего уровня (%d суток)",
				tier.Resolution, tier.RetentionDays, previous.RetentionDays)
		}
	}
	return nil
}

// Run строит недостающие агрегаты и удаляет истёкшие свечи.
//
// Сначала проходятся все уровни, и только потом применяются сроки хранения:
// удалять детализацию до того, как построен агрегат, значило бы терять её
// безвозвратно.
func (s *Service) Run(ctx context.Context) error {
	for _, tier := range s.tiers {
		if tier.From == 0 {
			continue
		}

		created, err := s.store.Aggregate(ctx, tier.From, tier.Resolution)
		if err != nil {
			return fmt.Errorf("свёртка %d->%d: %w", tier.From, tier.Resolution, err)
		}
		if created > 0 {
			s.logger.Info("candles aggregated",
				"from", tier.From, "to", tier.Resolution, "created", created)
		}
	}

	for _, tier := range s.tiers {
		removed, err := s.store.Prune(ctx, tier.Resolution, tier.RetentionDays)
		if err != nil {
			return fmt.Errorf("удаление истёкших свечей разрешения %d: %w", tier.Resolution, err)
		}
		if removed > 0 {
			s.logger.Info("candles pruned",
				"resolution", tier.Resolution, "older_than_days", tier.RetentionDays, "removed", removed)
		}
	}
	return nil
}

// Loop ведёт уровни детализации в фоне.
//
// Срок прохода задаёт запаздывание самого мелкого из строимых уровней:
// пятиминутная свеча появится не раньше, чем пройдёт очередной проход после
// закрытия её периода. Поэтому проходы частые, хотя сроки хранения
// измеряются месяцами. Отказ не прерывает работу: обрабатываются только
// закрытые периоды, и неудачный проход повторяется на следующем.
func (s *Service) Loop(ctx context.Context, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	for {
		if err := s.Run(ctx); err != nil && ctx.Err() == nil {
			s.logger.Error("rollup pass failed", "error", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
