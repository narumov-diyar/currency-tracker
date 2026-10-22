package rollup

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
)

type aggregateCall struct {
	From int16
	To   int16
}

type pruneCall struct {
	Resolution int16
	Days       int
}

type fakeStore struct {
	aggregated []aggregateCall
	pruned     []pruneCall
	created    int
	err        error
}

func (f *fakeStore) Aggregate(_ context.Context, from, to int16) (int, error) {
	f.aggregated = append(f.aggregated, aggregateCall{From: from, To: to})
	if f.err != nil {
		return 0, f.err
	}
	return f.created, nil
}

func (f *fakeStore) Prune(_ context.Context, resolution int16, days int) (int, error) {
	f.pruned = append(f.pruned, pruneCall{Resolution: resolution, Days: days})
	if f.err != nil {
		return 0, f.err
	}
	return 0, nil
}

func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// Минутный уровень пишет сборщик, поэтому строятся только три
// укрупнённых, и каждый — из предыдущего.
func TestRunAggregatesEachDerivedTier(t *testing.T) {
	store := &fakeStore{created: 1}
	service := NewService(store, DefaultTiers, quiet())

	if err := service.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}

	want := []aggregateCall{{From: 1, To: 5}, {From: 5, To: 60}, {From: 60, To: 1440}}
	if len(store.aggregated) != len(want) {
		t.Fatalf("got %d aggregate calls, want %d", len(store.aggregated), len(want))
	}
	for i, got := range store.aggregated {
		if got != want[i] {
			t.Errorf("aggregate call %d = %+v, want %+v", i, got, want[i])
		}
	}
}

// Сроки хранения применяются ко всем уровням, включая минутный, и только
// после того, как построены все агрегаты: удалять детализацию до этого
// значило бы терять её безвозвратно.
func TestRunPrunesAfterAggregating(t *testing.T) {
	store := &fakeStore{created: 1}
	service := NewService(store, DefaultTiers, quiet())

	if err := service.Run(context.Background()); err != nil {
		t.Fatalf("run: %v", err)
	}

	want := []pruneCall{
		{Resolution: 1, Days: 30},
		{Resolution: 5, Days: 90},
		{Resolution: 60, Days: 730},
		{Resolution: 1440, Days: 3650},
	}
	if len(store.pruned) != len(want) {
		t.Fatalf("got %d prune calls, want %d", len(store.pruned), len(want))
	}
	for i, got := range store.pruned {
		if got != want[i] {
			t.Errorf("prune call %d = %+v, want %+v", i, got, want[i])
		}
	}
}

// Отказ при построении агрегатов не должен доходить до удаления: иначе
// детализация ушла бы, а заменить её было бы нечем.
func TestRunDoesNotPruneWhenAggregationFails(t *testing.T) {
	failure := errors.New("база недоступна")
	store := &fakeStore{err: failure}
	service := NewService(store, DefaultTiers, quiet())

	err := service.Run(context.Background())
	if !errors.Is(err, failure) {
		t.Fatalf("error = %v, want the store failure", err)
	}
	if len(store.aggregated) != 1 {
		t.Errorf("made %d aggregate calls, want to stop after the first failure", len(store.aggregated))
	}
	if len(store.pruned) != 0 {
		t.Errorf("made %d prune calls, want none after a failed aggregation", len(store.pruned))
	}
}

func TestValidateAcceptsDefaultTiers(t *testing.T) {
	if err := Validate(DefaultTiers); err != nil {
		t.Errorf("default tiers rejected: %v", err)
	}
}

// Разрыв в цепочке не вызвал бы отказа, но оставил бы разрешение,
// которое никто не строит, то есть пустой график на этом периоде.
func TestValidateRejectsBrokenChain(t *testing.T) {
	tiers := []Tier{
		{Resolution: 1, From: 0, RetentionDays: 30},
		{Resolution: 60, From: 5, RetentionDays: 730},
	}
	if err := Validate(tiers); err == nil {
		t.Error("broken chain accepted, want a complaint about the missing 5m tier")
	}
}

// Срок хранения, убывающий вверх по цепочке, означал бы удаление агрегата
// раньше данных, из которых он построен.
func TestValidateRejectsShrinkingRetention(t *testing.T) {
	tiers := []Tier{
		{Resolution: 1, From: 0, RetentionDays: 90},
		{Resolution: 5, From: 1, RetentionDays: 30},
	}
	if err := Validate(tiers); err == nil {
		t.Error("shrinking retention accepted, want a complaint")
	}
}

func TestValidateRejectsBadTiers(t *testing.T) {
	cases := map[string][]Tier{
		"пустой набор": {},
		"базовый уровень строится из другого": {
			{Resolution: 5, From: 1, RetentionDays: 90},
		},
		"разрешение вне схемы": {
			{Resolution: 1, From: 0, RetentionDays: 30},
			{Resolution: 7, From: 1, RetentionDays: 90},
		},
		"шаг не укрупняется": {
			{Resolution: 5, From: 0, RetentionDays: 30},
			{Resolution: 1, From: 5, RetentionDays: 90},
		},
		"неположительный срок": {
			{Resolution: 1, From: 0, RetentionDays: 0},
		},
	}

	for name, tiers := range cases {
		if err := Validate(tiers); err == nil {
			t.Errorf("%s: принято, ожидался отказ", name)
		}
	}
}
