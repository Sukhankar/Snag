// Package auth holds the permission catalog and password hashing.
package auth

// Permission is one grantable capability. Keys are stored in roles.permissions.
type Permission struct {
	Key         string `json:"key"`
	Group       string `json:"group"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// Catalog is the single source of truth; the dashboard renders its permission grid from it.
// Adding a key here (and enforcing it in a handler) is all that's needed for a new permission.
var Catalog = []Permission{
	{"tickets.view", "Tickets", "View tickets", "See the inbox, board, ticket details, telemetry and attachments."},
	{"tickets.update", "Tickets", "Update tickets", "Change status, priority, category and team."},
	{"tickets.assign", "Tickets", "Assign tickets", "Set or change a ticket's assignee."},
	{"tickets.classify", "Tickets", "Classify AMC scope", "Mark tickets as AMC-covered bug or billable change request."},
	{"tickets.link", "Tickets", "Link duplicates", "Link and unlink duplicate tickets."},
	{"tickets.reply", "Tickets", "Reply to clients", "Send public replies that clients see in their widget."},
	{"tickets.note", "Tickets", "Internal notes", "Read-write private developer notes (never shown to clients)."},
	{"tickets.broadcast", "Tickets", "Broadcast to duplicates", "Send one public update to every reporter of linked duplicates."},
	{"projects.view", "Projects", "View projects", "See client projects, project keys and embed snippets."},
	{"projects.manage", "Projects", "Manage projects", "Create projects, edit allowed origins, rotate keys, disable projects."},
	{"teams.manage", "Projects", "Manage teams", "Create teams that tickets can be routed to."},
	{"users.manage", "Administration", "Manage users", "Create users, change their roles, reset passwords, deactivate accounts."},
	{"roles.manage", "Administration", "Manage roles", "Create, edit and delete roles and their permissions."},
}

var known = func() map[string]bool {
	m := make(map[string]bool, len(Catalog))
	for _, p := range Catalog {
		m[p.Key] = true
	}
	return m
}()

// Valid reports whether key exists in the catalog.
func Valid(key string) bool { return known[key] }

// AllKeys returns every permission key, in catalog order.
func AllKeys() []string {
	out := make([]string, len(Catalog))
	for i, p := range Catalog {
		out[i] = p.Key
	}
	return out
}
