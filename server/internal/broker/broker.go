// Package broker is an in-process pub/sub fan-out used by the SSE endpoints.
//
// Topics:
//   - "admin"                         every event, for the operations dashboard
//   - "reporter:<projectID>:<token>"  client-safe events for one widget user
//
// Publishing never blocks: a subscriber whose buffer is full is disconnected (its channel
// closed) and the client's EventSource reconnects and re-fetches state.
//
// The broker is single-process. To run several server replicas, put Postgres LISTEN/NOTIFY
// (or Redis pub/sub) in front of Publish; the SSE handlers do not need to change.
package broker

import (
	"encoding/json"
	"sync"
)

const AdminTopic = "admin"

func ReporterTopic(projectID, reporterToken string) string {
	return "reporter:" + projectID + ":" + reporterToken
}

// Frame is one pre-encoded SSE event.
type Frame struct {
	Event string
	Data  []byte
	// Restricted frames (internal notes) are only delivered to subscribers allowed to see
	// them; the SSE handler does the filtering.
	Restricted bool
}

type Subscription struct {
	C     <-chan Frame
	ch    chan Frame
	topic string
	once  sync.Once
}

type Broker struct {
	mu     sync.RWMutex
	topics map[string]map[*Subscription]struct{}
	closed bool
}

func New() *Broker {
	return &Broker{topics: make(map[string]map[*Subscription]struct{})}
}

func (b *Broker) Subscribe(topic string) *Subscription {
	ch := make(chan Frame, 64)
	s := &Subscription{C: ch, ch: ch, topic: topic}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		close(ch)
		return s
	}
	if b.topics[topic] == nil {
		b.topics[topic] = make(map[*Subscription]struct{})
	}
	b.topics[topic][s] = struct{}{}
	return s
}

func (b *Broker) Unsubscribe(s *Subscription) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.removeLocked(s)
}

func (b *Broker) removeLocked(s *Subscription) {
	if subs, ok := b.topics[s.topic]; ok {
		if _, ok := subs[s]; ok {
			delete(subs, s)
			if len(subs) == 0 {
				delete(b.topics, s.topic)
			}
		}
	}
	s.once.Do(func() { close(s.ch) })
}

// Publish JSON-encodes data once and fans it out to every subscriber of topic.
func (b *Broker) Publish(topic, event string, data any) { b.publish(topic, event, data, false) }

// PublishRestricted is Publish for frames only some subscribers may receive.
func (b *Broker) PublishRestricted(topic, event string, data any) {
	b.publish(topic, event, data, true)
}

func (b *Broker) publish(topic, event string, data any, restricted bool) {
	payload, err := json.Marshal(data)
	if err != nil {
		return
	}
	f := Frame{Event: event, Data: payload, Restricted: restricted}

	var slow []*Subscription
	b.mu.RLock()
	for s := range b.topics[topic] {
		select {
		case s.ch <- f:
		default:
			slow = append(slow, s)
		}
	}
	b.mu.RUnlock()

	if len(slow) > 0 {
		b.mu.Lock()
		for _, s := range slow {
			b.removeLocked(s)
		}
		b.mu.Unlock()
	}
}

// Close disconnects every subscriber; used during graceful shutdown so that long-lived SSE
// requests return and http.Server.Shutdown can complete.
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for _, subs := range b.topics {
		for s := range subs {
			s.once.Do(func() { close(s.ch) })
		}
	}
	b.topics = map[string]map[*Subscription]struct{}{}
}
