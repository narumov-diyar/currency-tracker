package storage

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// PendingRule — правило вместе со значениями, нужными для решения.
// Решение принимает код, а не база: условия проверяются тестами отдельно
// от SQL.
type PendingRule struct {
	ID            int64
	UserID        int64
	ConditionType string
	Direction     string
	TargetValue   float64
	Current       float64
	Previous      *float64
	Reference     *float64
}

// pendingAssetRules собирает активные правила на актив и три значения:
// текущее, предыдущее и то, что было в начале окна наблюдения.
//
// Окно у каждого правила своё, поэтому точка отсчёта вычисляется боковым
// соединением прямо из строки правила.
const pendingAssetRules = `
SELECT r.id, r.user_id, r.condition_type, r.direction, r.target_value::float8,
       curr.close_price::float8, prev.close_price::float8, ref.close_price::float8
FROM alert_rules r
JOIN assets a ON a.id = r.asset_id
CROSS JOIN LATERAL (
    SELECT close_price, collected_at
    FROM price_candles
    WHERE asset_id = a.id AND resolution = a.resolution_seconds / 60
    ORDER BY collected_at DESC
    LIMIT 1
) curr
LEFT JOIN LATERAL (
    SELECT close_price
    FROM price_candles
    WHERE asset_id = a.id AND resolution = a.resolution_seconds / 60
      AND collected_at < curr.collected_at
    ORDER BY collected_at DESC
    LIMIT 1
) prev ON true
LEFT JOIN LATERAL (
    SELECT close_price
    FROM price_candles
    WHERE asset_id = a.id AND resolution = a.resolution_seconds / 60
      AND collected_at <= curr.collected_at - make_interval(mins => coalesce(r.window_minutes, 0))
    ORDER BY collected_at DESC
    LIMIT 1
) ref ON true
WHERE r.asset_id = $1 AND r.status = 'active'`

// pendingPairRules делает то же для правил на кросс-курс.
//
// Курс считается делением цен сторон, причём редкая сторона подтягивается
// переносом последнего значения — так же, как на графике. Пара пересчитывается
// при обновлении любого из двух активов, поэтому условие по активу стоит
// на обеих сторонах.
const pendingPairRules = `
SELECT r.id, r.user_id, r.condition_type, r.direction, r.target_value::float8,
       (curr_b.close_price / nullif(curr_q.close_price, 0))::float8,
       (prev_b.close_price / nullif(prev_q.close_price, 0))::float8,
       (ref_b.close_price / nullif(ref_q.close_price, 0))::float8
FROM alert_rules r
JOIN user_pairs p ON p.id = r.pair_id
JOIN assets b ON b.id = p.base_asset_id
JOIN assets q ON q.id = p.quote_asset_id
CROSS JOIN LATERAL (
    SELECT max(collected_at) AS at
    FROM price_candles
    WHERE asset_id = $1 AND resolution = (
        SELECT resolution_seconds / 60 FROM assets WHERE id = $1
    )
) tip
CROSS JOIN LATERAL (SELECT close_price FROM price_candles
    WHERE asset_id = b.id AND resolution = b.resolution_seconds / 60 AND collected_at <= tip.at
    ORDER BY collected_at DESC LIMIT 1) curr_b
CROSS JOIN LATERAL (SELECT close_price FROM price_candles
    WHERE asset_id = q.id AND resolution = q.resolution_seconds / 60 AND collected_at <= tip.at
    ORDER BY collected_at DESC LIMIT 1) curr_q
LEFT JOIN LATERAL (SELECT close_price FROM price_candles
    WHERE asset_id = b.id AND resolution = b.resolution_seconds / 60 AND collected_at < tip.at
    ORDER BY collected_at DESC LIMIT 1) prev_b ON true
LEFT JOIN LATERAL (SELECT close_price FROM price_candles
    WHERE asset_id = q.id AND resolution = q.resolution_seconds / 60 AND collected_at < tip.at
    ORDER BY collected_at DESC LIMIT 1) prev_q ON true
LEFT JOIN LATERAL (SELECT close_price FROM price_candles
    WHERE asset_id = b.id AND resolution = b.resolution_seconds / 60
      AND collected_at <= tip.at - make_interval(mins => coalesce(r.window_minutes, 0))
    ORDER BY collected_at DESC LIMIT 1) ref_b ON true
LEFT JOIN LATERAL (SELECT close_price FROM price_candles
    WHERE asset_id = q.id AND resolution = q.resolution_seconds / 60
      AND collected_at <= tip.at - make_interval(mins => coalesce(r.window_minutes, 0))
    ORDER BY collected_at DESC LIMIT 1) ref_q ON true
WHERE r.status = 'active'
  AND curr_q.close_price <> 0
  AND (p.base_asset_id = $1 OR p.quote_asset_id = $1)`

func (a *Alerts) PendingForAsset(ctx context.Context, assetID int) ([]PendingRule, error) {
	return a.pending(ctx, pendingAssetRules, assetID)
}

func (a *Alerts) PendingForPairsWith(ctx context.Context, assetID int) ([]PendingRule, error) {
	return a.pending(ctx, pendingPairRules, assetID)
}

func (a *Alerts) pending(ctx context.Context, query string, assetID int) ([]PendingRule, error) {
	rows, err := a.pool.Query(ctx, query, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	rules := make([]PendingRule, 0, 32)
	for rows.Next() {
		var rule PendingRule
		if err := rows.Scan(&rule.ID, &rule.UserID, &rule.ConditionType, &rule.Direction,
			&rule.TargetValue, &rule.Current, &rule.Previous, &rule.Reference); err != nil {
			return nil, err
		}
		rules = append(rules, rule)
	}
	return rules, rows.Err()
}

// Trigger помечает правило сработавшим и создаёт уведомление.
//
// Условие status = 'active' в самом обновлении — это и есть защита от
// повторов: если правило уже перевели в сработавшее, обновление не затронет
// ни одной строки, и уведомление не появится. Проверять состояние отдельным
// запросом нельзя, между проверкой и записью мог бы вклиниться другой цикл.
func (a *Alerts) Trigger(ctx context.Context, ruleID, userID int64) (bool, error) {
	var triggered bool

	err := pgx.BeginFunc(ctx, a.pool, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`UPDATE alert_rules SET status = $1 WHERE id = $2 AND status = $3`,
			StatusTriggered, ruleID, StatusActive)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}

		if _, err := tx.Exec(ctx,
			`INSERT INTO notifications (user_id, alert_rule_id) VALUES ($1, $2)`,
			userID, ruleID); err != nil {
			return err
		}

		triggered = true
		return nil
	})

	return triggered, err
}
