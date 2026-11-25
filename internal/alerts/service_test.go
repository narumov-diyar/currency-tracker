package alerts

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/narumov-diyar/currency-tracker/internal/storage"
)

type stubStore struct {
	onAsset  []storage.PendingRule
	onPairs  []storage.PendingRule
	triggerd []int64
	// alreadyTriggered повторяет поведение базы: правило, уже переведённое
	// в сработавшее, второй раз не срабатывает.
	alreadyTriggered map[int64]bool
	failTrigger      bool
}

func (s *stubStore) PendingForAsset(context.Context, int) ([]storage.PendingRule, error) {
	return s.onAsset, nil
}

func (s *stubStore) PendingForPairsWith(context.Context, int) ([]storage.PendingRule, error) {
	return s.onPairs, nil
}

func (s *stubStore) Trigger(_ context.Context, ruleID, _ int64) (bool, error) {
	if s.failTrigger {
		return false, errors.New("ошибка записи")
	}
	if s.alreadyTriggered[ruleID] {
		return false, nil
	}
	if s.alreadyTriggered == nil {
		s.alreadyTriggered = map[int64]bool{}
	}
	s.alreadyTriggered[ruleID] = true
	s.triggerd = append(s.triggerd, ruleID)
	return true, nil
}

func newService(store Store) *Service {
	return NewService(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func ptr(v float64) *float64 { return &v }

func TestCheckAssetFiresOnCrossing(t *testing.T) {
	store := &stubStore{onAsset: []storage.PendingRule{{
		ID: 1, UserID: 10, ConditionType: storage.ConditionThreshold,
		Direction: DirectionAbove, TargetValue: 70000,
		Previous: ptr(69000), Current: 71000,
	}}}

	fired, err := newService(store).CheckAsset(context.Background(), 1)
	if err != nil {
		t.Fatalf("CheckAsset: %v", err)
	}
	if fired != 1 {
		t.Errorf("сработало %d правил, ожидалось 1", fired)
	}
}

func TestCheckAssetIgnoresRuleWithoutHistory(t *testing.T) {
	// Первая котировка актива: предыдущего снимка нет, переход определить
	// не из чего.
	store := &stubStore{onAsset: []storage.PendingRule{{
		ID: 1, UserID: 10, ConditionType: storage.ConditionThreshold,
		Direction: DirectionAbove, TargetValue: 70000,
		Previous: nil, Current: 71000,
	}}}

	fired, _ := newService(store).CheckAsset(context.Background(), 1)
	if fired != 0 {
		t.Errorf("сработало %d правил, ожидалось 0", fired)
	}
}

func TestCheckAssetIgnoresPercentRuleWithoutWindow(t *testing.T) {
	store := &stubStore{onAsset: []storage.PendingRule{{
		ID: 1, UserID: 10, ConditionType: storage.ConditionPercent,
		Direction: DirectionAbove, TargetValue: 5,
		Reference: nil, Current: 110,
	}}}

	fired, _ := newService(store).CheckAsset(context.Background(), 1)
	if fired != 0 {
		t.Errorf("сработало %d правил, ожидалось 0 — окно ещё не набралось", fired)
	}
}

// Повторная проверка тех же данных не должна создавать второе уведомление:
// окончательное решение принимает база, и она же гасит повтор.
func TestRepeatedCheckDoesNotFireTwice(t *testing.T) {
	rule := storage.PendingRule{
		ID: 1, UserID: 10, ConditionType: storage.ConditionThreshold,
		Direction: DirectionAbove, TargetValue: 70000,
		Previous: ptr(69000), Current: 71000,
	}
	store := &stubStore{onAsset: []storage.PendingRule{rule}}
	service := newService(store)

	first, _ := service.CheckAsset(context.Background(), 1)
	second, _ := service.CheckAsset(context.Background(), 1)

	if first != 1 {
		t.Errorf("первая проверка: сработало %d, ожидалось 1", first)
	}
	if second != 0 {
		t.Errorf("повторная проверка: сработало %d, ожидалось 0", second)
	}
	if len(store.triggerd) != 1 {
		t.Errorf("уведомлений создано %d, ожидалось одно", len(store.triggerd))
	}
}

// Правило на пару пересчитывается при обновлении любой из её сторон,
// поэтому проверяются оба набора правил.
func TestCheckAssetCoversPairRules(t *testing.T) {
	store := &stubStore{
		onAsset: []storage.PendingRule{{
			ID: 1, UserID: 10, ConditionType: storage.ConditionThreshold,
			Direction: DirectionAbove, TargetValue: 70000,
			Previous: ptr(69000), Current: 71000,
		}},
		onPairs: []storage.PendingRule{{
			ID: 2, UserID: 10, ConditionType: storage.ConditionPercent,
			Direction: DirectionBelow, TargetValue: 5,
			Reference: ptr(100), Current: 90,
		}},
	}

	fired, err := newService(store).CheckAsset(context.Background(), 1)
	if err != nil {
		t.Fatalf("CheckAsset: %v", err)
	}
	if fired != 2 {
		t.Errorf("сработало %d правил, ожидалось 2", fired)
	}
}

func TestCheckAssetReportsStoreFailure(t *testing.T) {
	store := &stubStore{
		failTrigger: true,
		onAsset: []storage.PendingRule{{
			ID: 1, UserID: 10, ConditionType: storage.ConditionThreshold,
			Direction: DirectionAbove, TargetValue: 70000,
			Previous: ptr(69000), Current: 71000,
		}},
	}

	if _, err := newService(store).CheckAsset(context.Background(), 1); err == nil {
		t.Error("ошибка записи должна возвращаться наружу")
	}
}

func TestUnknownConditionDoesNotFire(t *testing.T) {
	store := &stubStore{onAsset: []storage.PendingRule{{
		ID: 1, UserID: 10, ConditionType: "trend",
		Direction: DirectionAbove, TargetValue: 1,
		Previous: ptr(1), Current: 100,
	}}}

	fired, _ := newService(store).CheckAsset(context.Background(), 1)
	if fired != 0 {
		t.Errorf("сработало %d правил, ожидалось 0", fired)
	}
}

type errorStore struct {
	stubStore
	assetError, pairError error
	calls                 [][2]int64
}

func (s *errorStore) PendingForAsset(context.Context, int) ([]storage.PendingRule, error) {
	return s.onAsset, s.assetError
}

func (s *errorStore) PendingForPairsWith(context.Context, int) ([]storage.PendingRule, error) {
	return s.onPairs, s.pairError
}

func (s *errorStore) Trigger(_ context.Context, ruleID, userID int64) (bool, error) {
	s.calls = append(s.calls, [2]int64{ruleID, userID})
	if len(s.calls) == 2 {
		return false, errStoreFailure
	}
	return true, nil
}

var errStoreFailure = errors.New("store failure")

func TestCheckAssetReportsQueryErrors(t *testing.T) {
	for _, tc := range []struct {
		name              string
		assetErr, pairErr error
	}{
		{"asset", errStoreFailure, nil},
		{"pair", nil, errStoreFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &errorStore{assetError: tc.assetErr, pairError: tc.pairErr}
			got, err := newService(store).CheckAsset(context.Background(), 1)
			if !errors.Is(err, errStoreFailure) || got != 0 || len(store.calls) != 0 {
				t.Fatalf("fired=%d, error=%v, calls=%v", got, err, store.calls)
			}
		})
	}
}

func TestCheckAssetReturnsPartialResult(t *testing.T) {
	matching := func(id, owner int64) storage.PendingRule {
		return storage.PendingRule{ID: id, UserID: owner, ConditionType: storage.ConditionThreshold,
			Direction: DirectionAbove, TargetValue: 10, Previous: ptr(9), Current: 10}
	}
	skipped := matching(1, 11)
	skipped.Current = 9
	store := &errorStore{stubStore: stubStore{
		onAsset: []storage.PendingRule{skipped, matching(2, 22)},
		onPairs: []storage.PendingRule{matching(3, 33), matching(4, 44)},
	}}
	got, err := newService(store).CheckAsset(context.Background(), 1)
	if !errors.Is(err, errStoreFailure) || got != 1 {
		t.Fatalf("fired=%d, error=%v", got, err)
	}
	if len(store.calls) != 2 || store.calls[0] != [2]int64{2, 22} || store.calls[1] != [2]int64{3, 33} {
		t.Fatalf("unexpected rule/owner calls: %v", store.calls)
	}
}
