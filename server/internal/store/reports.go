package store

import (
	"context"
	"time"
)

// AMCRow summarises one project's tickets for an AMC (annual maintenance contract) period:
// how much was covered work (bug) versus billable new scope (change request).
type AMCRow struct {
	ProjectID     string `json:"project_id"`
	ProjectName   string `json:"project_name"`
	Total         int    `json:"total"`
	Bug           int    `json:"bug"`
	ChangeRequest int    `json:"change_request"`
	Unclassified  int    `json:"unclassified"`
	Open          int    `json:"open"`
	Resolved      int    `json:"resolved"`
	Duplicates    int    `json:"duplicates"`
	// AvgResolutionHours is measured from creation to the first resolve/close recorded in the
	// activity log; nil when no ticket in the period has one yet.
	AvgResolutionHours *float64 `json:"avg_resolution_hours"`
}

// AMCReport aggregates tickets created in [from, to) per project, optionally for one project.
func (r *AdminRepo) AMCReport(ctx context.Context, from, to time.Time, projectID string) ([]AMCRow, error) {
	rows, err := r.pool.Query(ctx, `
		WITH resolved AS (
			SELECT ticket_id, min(created_at) AS at
			FROM ticket_events
			WHERE field = 'status' AND new_value IN ('resolved', 'closed')
			GROUP BY ticket_id
		)
		SELECT p.id, p.name,
		       count(*)::int,
		       count(*) FILTER (WHERE t.scope_class = 'bug')::int,
		       count(*) FILTER (WHERE t.scope_class = 'change_request')::int,
		       count(*) FILTER (WHERE t.scope_class = 'unclassified')::int,
		       count(*) FILTER (WHERE t.status IN ('new', 'triaged', 'in_progress'))::int,
		       count(*) FILTER (WHERE t.status IN ('resolved', 'closed'))::int,
		       count(*) FILTER (WHERE t.parent_ticket_id IS NOT NULL)::int,
		       avg(extract(epoch FROM (res.at - t.created_at)) / 3600) FILTER (WHERE res.at IS NOT NULL)
		FROM tickets t
		JOIN projects p ON p.id = t.project_id
		LEFT JOIN resolved res ON res.ticket_id = t.id
		WHERE t.created_at >= $1 AND t.created_at < $2 AND ($3 = '' OR t.project_id::text = $3)
		GROUP BY p.id, p.name
		ORDER BY count(*) DESC, p.name`, from, to, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AMCRow{}
	for rows.Next() {
		var row AMCRow
		if err := rows.Scan(&row.ProjectID, &row.ProjectName, &row.Total, &row.Bug, &row.ChangeRequest, &row.Unclassified,
			&row.Open, &row.Resolved, &row.Duplicates, &row.AvgResolutionHours); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
