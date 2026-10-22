package storage

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Агрегат строится сразу после закрытия периода, а не когда исходные строки
// доживают до своего срока: график за сутки идёт по пятиминутным свечам,
// и ждать месяц значило бы отдавать пустой график за последний месяц.
//
// Отметкой обработанного служит последняя построенная свеча целевого
// разрешения — записи приходят по возрастанию времени, поэтому максимум
// и есть граница. Текущий период исключается целиком: он ещё наполняется,
// а дописать свечу потом нельзя, уникальный ключ отсечёт по времени.
const aggregateQuery = `
WITH edge AS (
    SELECT date_bin(make_interval(mins => $2), now(), timestamptz 'epoch') AS at
),
built AS (
    SELECT asset_id, max(collected_at) AS at
    FROM price_candles
    WHERE resolution = $2
    GROUP BY asset_id
),
source AS (
    SELECT c.asset_id, c.collected_at, c.open_price, c.high_price, c.low_price,
           c.close_price, c.volume, c.turnover,
           date_bin(make_interval(mins => $2), c.collected_at, timestamptz 'epoch') AS bucket
    FROM price_candles c
    CROSS JOIN edge
    LEFT JOIN built b ON b.asset_id = c.asset_id
    WHERE c.resolution = $1
      AND c.collected_at < edge.at
      AND (b.at IS NULL OR c.collected_at >= b.at + make_interval(mins => $2))
),
folded AS (
    SELECT asset_id, bucket,
           (array_agg(open_price ORDER BY collected_at))[1]       AS open_price,
           max(high_price)                                       AS high_price,
           min(low_price)                                         AS low_price,
           (array_agg(close_price ORDER BY collected_at DESC))[1] AS close_price,
           sum(volume)                                            AS volume,
           sum(turnover)                                          AS turnover
    FROM source
    GROUP BY asset_id, bucket
),
inserted AS (
    INSERT INTO price_candles (asset_id, resolution, collected_at, open_price,
                               high_price, low_price, close_price, volume, turnover)
    SELECT asset_id, $2::smallint, bucket, open_price, high_price, low_price,
           close_price, volume, turnover
    FROM folded
    ON CONFLICT (asset_id, resolution, collected_at) DO NOTHING
    RETURNING 1
)
SELECT count(*) FROM inserted`

const pruneQuery = `
DELETE FROM price_candles
WHERE resolution = $1 AND collected_at < now() - make_interval(days => $2)`

type Rollups struct {
	pool *pgxpool.Pool
}

func NewRollups(pool *pgxpool.Pool) *Rollups {
	return &Rollups{pool: pool}
}

// Aggregate строит свечи разрешения to из свечей разрешения from за все
// закрытые периоды, для которых агрегата ещё нет.
func (r *Rollups) Aggregate(ctx context.Context, from, to int16) (int, error) {
	var created int
	err := r.pool.QueryRow(ctx, aggregateQuery, from, to).Scan(&created)
	return created, err
}

// Prune удаляет свечи разрешения resolution старше days суток.
func (r *Rollups) Prune(ctx context.Context, resolution int16, days int) (int, error) {
	tag, err := r.pool.Exec(ctx, pruneQuery, resolution, days)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
