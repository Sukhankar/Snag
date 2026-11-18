package broker

import (
	"sync"
	"testing"
)

func TestIsolationOverflowAndClose(t *testing.T) {
	b := New()
	a := b.Subscribe("a")
	other := b.Subscribe("b")
	b.PublishRestricted("a", "secret", map[string]int{"x": 1})
	f := <-a.C
	if !f.Restricted || f.Event != "secret" {
		t.Fatal("frame lost")
	}
	select {
	case <-other.C:
		t.Fatal("cross-topic leak")
	default:
	}
	for i := 0; i < 65; i++ {
		b.Publish("a", "event", i)
	}
	n := 0
	for range a.C {
		n++
	}
	if n != 64 {
		t.Fatal(n)
	}
	b.Unsubscribe(a)
	b.Close()
	b.Close()
	if _, ok := <-b.Subscribe("a").C; ok {
		t.Fatal("subscribe after close")
	}
}
func TestConcurrentPublishSubscribe(t *testing.T) {
	b := New()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s := b.Subscribe("a")
			for j := 0; j < 100; j++ {
				b.Publish("a", "event", j)
			}
			b.Unsubscribe(s)
		}()
	}
	wg.Wait()
	b.Close()
}
