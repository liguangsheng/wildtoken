package db

import (
	"context"
	"database/sql"
	"math"
	"slices"
	"strings"
	"time"
)

// LogOverviewOut carries the range-scoped aggregates behind the dashboard's
// KPI cards, status distribution, and latency trend. One request replaces the
// previous client-side math over "the most recent ~200 loaded logs", whose
// meaning drifted with traffic volume.
type LogOverviewOut struct {
	Range         string `json:"range"`
	RangeLabel    string `json:"range_label"`
	TotalRequests int64  `json:"total_requests"`
	// PreviousTotal 是上一个同长周期的请求总数，给增长率当基数。今天对比
	// 昨天同时段；固定窗口对比再往前一个窗口；自定义对比等长的前置区间；
	// "全部"没有上一周期，字段为 null。
	PreviousTotal *int64 `json:"previous_total"`
	// PreviousStatus 是上一同长周期的分类计数，给状态分布图例的环比用。
	PreviousStatus *StatusCounts      `json:"previous_status"`
	ErrorRequests  int64              `json:"error_requests"`
	Status2xx      int64              `json:"status_2xx"`
	Status4xx      int64              `json:"status_4xx"`
	Status5xx      int64              `json:"status_5xx"`
	StatusOther    int64              `json:"status_other"`
	DurationCount  int64              `json:"duration_count"`
	AvgDurationMs  float64            `json:"avg_duration_ms"`
	MinDurationMs  int64              `json:"min_duration_ms"`
	MaxDurationMs  int64              `json:"max_duration_ms"`
	// P50/P95/P99 是全窗口耗时的最近邻分位数。均值会被一条慢请求拉高，
	// 分位数区分"普遍变慢"和"偶发超时"。无有效耗时时为 null。
	P50DurationMs  *float64           `json:"p50_duration_ms"`
	P95DurationMs  *float64           `json:"p95_duration_ms"`
	P99DurationMs  *float64           `json:"p99_duration_ms"`
	BucketSeconds  int64              `json:"bucket_seconds"`
	LatencySeries  []LatencyBucketOut `json:"latency_series"`
	// RequestSeries 按同一套分桶统计全部请求（不过滤耗时），是请求量趋势的
	// 数据源——LatencySeries 里的 count 只数有耗时的行，当请求量用会偏低。
	RequestSeries []RequestBucketOut `json:"request_series"`
}

// LatencyBucketOut is one time bucket of the latency trend.
type LatencyBucketOut struct {
	BucketEpoch int64   `json:"bucket_epoch"`
	AvgMs       float64 `json:"avg_ms"`
	Count       int64   `json:"count"`
	// P50Ms/P95Ms/P99Ms are nearest-rank quantiles of the bucket's durations;
	// null when the bucket has no timed rows.
	P50Ms *float64 `json:"p50_ms,omitempty"`
	P95Ms *float64 `json:"p95_ms,omitempty"`
	P99Ms *float64 `json:"p99_ms,omitempty"`
}

// RequestBucketOut is one time bucket of the request-volume trend. Errors
// feeds the status card's error-time strip: which buckets the failures
// cluster in, not just how many there were overall.
type RequestBucketOut struct {
	BucketEpoch int64 `json:"bucket_epoch"`
	Count       int64 `json:"count"`
	Errors      int64 `json:"errors"`
}

// StatusCounts carries per-class request counts for one window.
type StatusCounts struct {
	Total       int64 `json:"total"`
	Status2xx   int64 `json:"status_2xx"`
	Status4xx   int64 `json:"status_4xx"`
	Status5xx   int64 `json:"status_5xx"`
	StatusOther int64 `json:"status_other"`
}

/*
latencyBucketSteps are the allowed bucket widths, smallest first. The series

	aims for ~40 buckets over the selected span and rounds up to the next step,
	so "today" gets half-hour buckets while "30 天" gets daily ones — the chart
	stays readable at any range instead of scaling point count with traffic.
*/
var latencyBucketSteps = []int64{
	30 * 60,
	60 * 60,
	2 * 60 * 60,
	3 * 60 * 60,
	6 * 60 * 60,
	12 * 60 * 60,
	24 * 60 * 60,
	2 * 24 * 60 * 60,
	7 * 24 * 60 * 60,
}

const latencyTargetBuckets = 40

func latencyBucketSeconds(spanSeconds int64) int64 {
	raw := spanSeconds / latencyTargetBuckets
	for _, step := range latencyBucketSteps {
		if raw <= step {
			return step
		}
	}
	// Beyond the table (multi-year "all" spans): whole weeks.
	week := latencyBucketSteps[len(latencyBucketSteps)-1]
	return ((raw + week - 1) / week) * week
}

// overviewSpanSeconds resolves the selected range to a span for bucket sizing.
// Returns 0 when the span is unknown (empty table under "all"), in which case
// the caller falls back to the smallest bucket.
func overviewSpanSeconds(ctx context.Context, database *sql.DB,
	window LogTopWindow, startAt, endAt string) (int64, error) {
	var start, end sql.NullInt64
	switch window {
	case LogTopWindowCustom:
		row := database.QueryRowContext(ctx,
			"SELECT CAST(strftime('%s', ?) AS INTEGER), CAST(strftime('%s', ?) AS INTEGER)",
			startAt, endAt)
		if err := row.Scan(&start, &end); err != nil {
			return 0, err
		}
	case LogTopWindowAll:
		row := database.QueryRowContext(ctx,
			"SELECT CAST(strftime('%s', MIN(created_at)) AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER) FROM request_logs")
		if err := row.Scan(&start, &end); err != nil {
			return 0, err
		}
	default:
		// The cutoff expression is a compile-time constant of this package,
		// never caller input.
		row := database.QueryRowContext(ctx,
			"SELECT CAST(strftime('%s', "+window.cutoffExpression()+") AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)")
		if err := row.Scan(&start, &end); err != nil {
			return 0, err
		}
	}
	if !start.Valid || !end.Valid || end.Int64 <= start.Int64 {
		return 0, nil
	}
	return end.Int64 - start.Int64, nil
}

// LogOverview aggregates request totals, status buckets, latency stats, and a
// time-bucketed latency series over the selected window.
func LogOverview(ctx context.Context, database *sql.DB,
	window LogTopWindow, startAt, endAt string) (LogOverviewOut, error) {
	var out LogOverviewOut

	var predicate strings.Builder
	predicateArgs, err := appendLogTimePredicate(&predicate, nil, window, startAt, endAt)
	if err != nil {
		return out, err
	}

	// 错误口径与前端一致：无状态码，或非 2xx。
	aggregateQuery := `
		SELECT
			COUNT(*),
			COALESCE(SUM(CASE WHEN status_code IS NULL OR status_code < 200 OR status_code >= 300 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0),
			COALESCE(MIN(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms END), 0),
			COALESCE(MAX(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms END), 0)
		FROM request_logs
		WHERE ` + predicate.String()
	var durationSum int64
	row := database.QueryRowContext(ctx, aggregateQuery, predicateArgs...)
	if err := row.Scan(&out.TotalRequests, &out.ErrorRequests,
		&out.Status2xx, &out.Status4xx, &out.Status5xx,
		&out.DurationCount, &durationSum,
		&out.MinDurationMs, &out.MaxDurationMs); err != nil {
		return out, err
	}
	out.StatusOther = out.TotalRequests - out.Status2xx - out.Status4xx - out.Status5xx
	if out.DurationCount > 0 {
		out.AvgDurationMs = float64(durationSum) / float64(out.DurationCount)
	}

	span, err := overviewSpanSeconds(ctx, database, window, startAt, endAt)
	if err != nil {
		return out, err
	}
	out.BucketSeconds = latencyBucketSteps[0]
	if span > 0 {
		out.BucketSeconds = latencyBucketSeconds(span)
	}

	// 一条分桶查询同时供出两个序列：COUNT(*) 数全部请求（请求量趋势），
	// AVG 只吃有效耗时（SQL 的 AVG 会忽略 CASE 落空的 NULL），错误数给
	// 状态卡的时间细带定位失败发生在哪些桶。
	seriesQuery := `
		SELECT
			(CAST(strftime('%s', created_at) AS INTEGER) / ?) * ? AS bucket_epoch,
			COUNT(*),
			COALESCE(SUM(CASE WHEN status_code IS NULL OR status_code < 200 OR status_code >= 300 THEN 1 ELSE 0 END), 0),
			AVG(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms END),
			COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0)
		FROM request_logs
		WHERE ` + predicate.String() + `
		GROUP BY bucket_epoch
		ORDER BY bucket_epoch ASC`
	seriesArgs := append([]any{out.BucketSeconds, out.BucketSeconds}, predicateArgs...)
	rows, err := database.QueryContext(ctx, seriesQuery, seriesArgs...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	out.LatencySeries = []LatencyBucketOut{}
	out.RequestSeries = []RequestBucketOut{}
	for rows.Next() {
		var epoch, requests, bucketErrors, durationRows int64
		var avgMs sql.NullFloat64
		if err := rows.Scan(&epoch, &requests, &bucketErrors, &avgMs, &durationRows); err != nil {
			return out, err
		}
		out.RequestSeries = append(out.RequestSeries, RequestBucketOut{
			BucketEpoch: epoch,
			Count:       requests,
			Errors:      bucketErrors,
		})
		if durationRows > 0 && avgMs.Valid {
			out.LatencySeries = append(out.LatencySeries, LatencyBucketOut{
				BucketEpoch: epoch,
				AvgMs:       avgMs.Float64,
				Count:       durationRows,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}

	previousCounts, hasPrevious, err := previousWindowCounts(ctx, database, window, startAt, endAt)
	if err != nil {
		return out, err
	}
	if hasPrevious {
		out.PreviousTotal = &previousCounts.Total
		out.PreviousStatus = &previousCounts
	}

	if err := fillLatencyQuantiles(ctx, database, &out, predicate.String(), predicateArgs); err != nil {
		return out, err
	}
	return out, nil
}

// maxQuantileDurations bounds the rows the quantile pass buffers. Beyond it the
// quantiles stay null rather than paying an unbounded scan+sort per console
// load; retention normally keeps the window far below this.
const maxQuantileDurations = 200_000

// fillLatencyQuantiles walks the window's durations once, bucketed and sorted,
// and fills nearest-rank P50/P95/P99 both per bucket and for the whole window.
// SQLite has no percentile aggregate, and the row count is retention-bounded,
// so computing in Go over one ordered scan is the cheap option.
func fillLatencyQuantiles(ctx context.Context, database *sql.DB, out *LogOverviewOut,
	predicate string, predicateArgs []any) error {
	if out.DurationCount == 0 || out.DurationCount > maxQuantileDurations {
		return nil
	}

	// ORDER BY bucket, duration keeps every bucket's slice sorted as scanned,
	// so no per-bucket sort is needed; the window-wide slice is sorted once.
	durationsQuery := `
		SELECT (CAST(strftime('%s', created_at) AS INTEGER) / ?) * ? AS bucket_epoch, duration_ms
		FROM request_logs
		WHERE ` + predicate + ` AND duration_ms IS NOT NULL AND duration_ms >= 0
		ORDER BY bucket_epoch ASC, duration_ms ASC`
	args := append([]any{out.BucketSeconds, out.BucketSeconds}, predicateArgs...)
	rows, err := database.QueryContext(ctx, durationsQuery, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	byBucket := make(map[int64][]float64, len(out.LatencySeries))
	all := make([]float64, 0, out.DurationCount)
	for rows.Next() {
		var epoch int64
		var durationMs float64
		if err := rows.Scan(&epoch, &durationMs); err != nil {
			return err
		}
		byBucket[epoch] = append(byBucket[epoch], durationMs)
		all = append(all, durationMs)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for i := range out.LatencySeries {
		bucket := &out.LatencySeries[i]
		durations := byBucket[bucket.BucketEpoch]
		if len(durations) == 0 {
			continue
		}
		p50, p95, p99 := quantiles(durations)
		bucket.P50Ms, bucket.P95Ms, bucket.P99Ms = &p50, &p95, &p99
	}
	slices.Sort(all)
	p50, p95, p99 := quantiles(all)
	out.P50DurationMs, out.P95DurationMs, out.P99DurationMs = &p50, &p95, &p99
	return nil
}

// quantiles returns the nearest-rank P50/P95/P99 of an ascending-sorted slice.
func quantiles(sorted []float64) (float64, float64, float64) {
	rank := func(p float64) int {
		index := int(math.Ceil(p * float64(len(sorted))))
		return min(max(index, 1), len(sorted))
	}
	return sorted[rank(0.50)-1], sorted[rank(0.95)-1], sorted[rank(0.99)-1]
}

/*
previousWindowCounts 统计"上一个同长周期"的请求总数与分类计数。今天对比

	昨天同时段（截至当前时刻），避免半天的今天永远输给完整的昨天；固定窗口
	整体后移一个窗口长度；自定义区间取等长的前置区间；"全部"没有可比周期。
*/
func previousWindowCounts(ctx context.Context, database *sql.DB,
	window LogTopWindow, startAt, endAt string) (StatusCounts, bool, error) {
	var counts StatusCounts
	var predicate string
	var args []any
	switch window {
	case LogTopWindowAll:
		return counts, false, nil
	case LogTopWindowCustom:
		start, err := time.Parse("2006-01-02 15:04:05", startAt)
		if err != nil {
			return counts, false, err
		}
		end, err := time.Parse("2006-01-02 15:04:05", endAt)
		if err != nil {
			return counts, false, err
		}
		span := end.Sub(start)
		predicate = "created_at >= ? AND created_at < ?"
		args = append(args, start.Add(-span).Format("2006-01-02 15:04:05"), startAt)
	case LogTopWindowToday:
		predicate = "created_at >= datetime('now', 'localtime', 'start of day', 'utc', '-1 day')" +
			" AND created_at < datetime('now', '-1 day')"
	case LogTopWindowOneDay:
		predicate = "created_at >= datetime('now', '-2 days') AND created_at < datetime('now', '-1 day')"
	case LogTopWindowThreeDays:
		predicate = "created_at >= datetime('now', '-6 days') AND created_at < datetime('now', '-3 days')"
	case LogTopWindowSevenDays:
		predicate = "created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')"
	case LogTopWindowThirtyDays:
		predicate = "created_at >= datetime('now', '-60 days') AND created_at < datetime('now', '-30 days')"
	default:
		return counts, false, nil
	}

	row := database.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END), 0)
		FROM request_logs WHERE `+predicate, args...)
	if err := row.Scan(&counts.Total, &counts.Status2xx, &counts.Status4xx, &counts.Status5xx); err != nil {
		return counts, false, err
	}
	counts.StatusOther = counts.Total - counts.Status2xx - counts.Status4xx - counts.Status5xx
	return counts, true, nil
}
