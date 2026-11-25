package storage

import (
	"context"
	"sync"
	"testing"
)

func TestTriggerIsAtomic(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	userID := seedUser(t, pool, "atomic@example.com")
	btc := assetID(t, pool, "BTC")
	alerts := NewAlerts(pool)
	createRule := func() int64 {
		t.Helper()
		rule, err := alerts.Create(ctx, NewAlertRule{UserID: userID, TargetType: TargetAsset, AssetID: &btc,
			ConditionType: ConditionThreshold, Direction: "above", TargetValue: "100"})
		if err != nil {
			t.Fatal(err)
		}
		return rule.ID
	}
	assertOutcome := func(id int64, wantStatus string, wantCount int) {
		t.Helper()
		var status string
		var count int
		err := pool.QueryRow(ctx, `SELECT status, (SELECT count(*) FROM notifications WHERE alert_rule_id = $1)
			FROM alert_rules WHERE id = $1`, id).Scan(&status, &count)
		if err != nil || status != wantStatus || count != wantCount {
			t.Fatalf("status=%s, notifications=%d, err=%v; want %s, %d", status, count, err, wantStatus, wantCount)
		}
	}

	id := createRule()
	type result struct {
		fired bool
		err   error
	}
	start := make(chan struct{})
	results := make(chan result, 10)
	var ready sync.WaitGroup
	ready.Add(cap(results))
	for range cap(results) {
		go func() {
			ready.Done()
			<-start
			fired, err := alerts.Trigger(ctx, id, userID)
			results <- result{fired, err}
		}()
	}
	ready.Wait()
	close(start)
	succeeded := 0
	for range cap(results) {
		out := <-results
		if out.err != nil {
			t.Error(out.err)
		}
		if out.fired {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful triggers: %d, want 1", succeeded)
	}
	assertOutcome(id, StatusTriggered, 1)
	if fired, err := alerts.Trigger(ctx, id, userID); fired || err != nil {
		t.Fatalf("repeated trigger: %v, %v", fired, err)
	}
	assertOutcome(id, StatusTriggered, 1)

	rollbackID := createRule()
	if fired, err := alerts.Trigger(ctx, rollbackID, -1); fired || err == nil {
		t.Fatalf("trigger with missing user: %v, %v", fired, err)
	}
	assertOutcome(rollbackID, StatusActive, 0)
}
