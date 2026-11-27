package storage

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestPendingAssetUsesNativeCandlesAndReferenceBoundary(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	user := seedUser(t, pool, "selection@example.com")
	btc, eth := assetID(t, pool, "BTC"), assetID(t, pool, "ETH")
	alerts := NewAlerts(pool)
	window := 15
	create := func(asset int, condition string, window *int) int64 {
		t.Helper()
		rule, err := alerts.Create(ctx, NewAlertRule{UserID: user, TargetType: TargetAsset, AssetID: &asset,
			ConditionType: condition, Direction: "above", TargetValue: "100", WindowMinutes: window})
		if err != nil {
			t.Fatal(err)
		}
		return rule.ID
	}
	threshold := create(btc, ConditionThreshold, nil)
	percent := create(btc, ConditionPercent, &window)
	other := create(eth, ConditionPercent, &window)
	if fired, err := alerts.Trigger(ctx, create(btc, ConditionThreshold, nil), user); !fired || err != nil {
		t.Fatalf("trigger: %t %v", fired, err)
	}
	tip := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	insertCandle(t, pool, btc, 1, tip, "130")
	insertCandle(t, pool, btc, 1, tip.Add(-time.Minute), "120")
	insertCandle(t, pool, btc, 1, tip.Add(-14*time.Minute), "110")
	insertCandle(t, pool, btc, 1, tip.Add(-15*time.Minute), "100")
	insertCandle(t, pool, btc, 1, tip.Add(-16*time.Minute), "90")
	insertCandle(t, pool, btc, 60, tip.Add(time.Minute), "999")
	insertCandle(t, pool, eth, 1, tip.Add(time.Minute), "777")

	rules, err := alerts.PendingForAsset(ctx, btc)
	if err != nil || len(rules) != 2 {
		t.Fatalf("BTC rules: %v, %v", rules, err)
	}
	byID := make(map[int64]PendingRule, len(rules))
	for _, rule := range rules {
		byID[rule.ID] = rule
	}
	for _, id := range []int64{threshold, percent} {
		rule := byID[id]
		if rule.Current != 130 || rule.Previous == nil || *rule.Previous != 120 {
			t.Errorf("rule %d: current=%v previous=%v, want 130 and 120", id, rule.Current, rule.Previous)
		}
	}
	if ref := byID[percent].Reference; ref == nil || *ref != 100 {
		t.Errorf("reference %v, want 100 exactly on the window boundary", ref)
	}
	rules, err = alerts.PendingForAsset(ctx, eth)
	if err != nil || len(rules) != 1 || rules[0].ID != other || rules[0].Current != 777 ||
		rules[0].Previous != nil || rules[0].Reference != nil {
		t.Fatalf("ETH rules with one candle: %v, %v", rules, err)
	}
}

func TestPendingPairsCarryFiatAndSkipZeroDenominator(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	if _, err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	user := seedUser(t, pool, "pair-selection@example.com")
	btc, rub, eth, eur := assetID(t, pool, "BTC"), assetID(t, pool, "RUB"), assetID(t, pool, "ETH"), assetID(t, pool, "EUR")
	alerts := NewAlerts(pool)
	create := func(base, quote int) int64 {
		t.Helper()
		var id int64
		err := pool.QueryRow(ctx, "INSERT INTO user_pairs (user_id, base_asset_id, quote_asset_id) VALUES ($1, $2, $3) RETURNING id", user, base, quote).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		rule, err := alerts.Create(ctx, NewAlertRule{UserID: user, TargetType: TargetPair, PairID: &id,
			ConditionType: ConditionThreshold, Direction: "above", TargetValue: "100"})
		if err != nil {
			t.Fatal(err)
		}
		return rule.ID
	}
	good := create(btc, rub)
	bad := create(btc, eur)
	unrelated := create(eth, eur)
	if fired, err := alerts.Trigger(ctx, unrelated, user); !fired || err != nil {
		t.Fatalf("trigger: %t %v", fired, err)
	}
	day := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	insertCandle(t, pool, rub, 1440, day.Add(-24*time.Hour), "0.01")
	insertCandle(t, pool, rub, 1440, day, "0.02")
	insertCandle(t, pool, eur, 1440, day.Add(-24*time.Hour), "0")
	insertCandle(t, pool, btc, 1, day.Add(-2*time.Minute), "100")
	insertCandle(t, pool, btc, 1, day.Add(-time.Minute), "120")
	insertCandle(t, pool, btc, 60, day, "999")

	for _, tc := range []struct {
		asset             int
		current, previous float64
	}{{btc, 12000, 10000}, {rub, 6000, 12000}} {
		rules, err := alerts.PendingForPairsWith(ctx, tc.asset)
		if err != nil || len(rules) != 1 || rules[0].ID != good {
			t.Fatalf("asset %d: rules=%v err=%v, want only rule %d (skip rule %d)", tc.asset, rules, err, good, bad)
		}
		rule := rules[0]
		if math.Abs(rule.Current-tc.current) > 1e-9 || rule.Previous == nil || math.Abs(*rule.Previous-tc.previous) > 1e-9 {
			t.Errorf("asset %d: current=%f previous=%v, want %f and %f", tc.asset, rule.Current, rule.Previous, tc.current, tc.previous)
		}
	}
}
