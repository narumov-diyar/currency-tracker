package stream

import (
	"strconv"
	"testing"
	"time"
)

// Буфер прореживает поток до шага, поэтому точки теста отстоят на секунду.
func point(i int) Point {
	return Point{At: time.Unix(int64(i), 0), Price: strconv.Itoa(i)}
}

func TestBufferKeepsOrderWhileFilling(t *testing.T) {
	buffer := NewBuffer(5)
	for i := 1; i <= 3; i++ {
		buffer.Add(point(i))
	}

	snapshot := buffer.Snapshot()
	if len(snapshot) != 3 {
		t.Fatalf("got %d points, want 3", len(snapshot))
	}
	for i, p := range snapshot {
		if p.Price != strconv.Itoa(i+1) {
			t.Errorf("point %d = %s, want %d", i, p.Price, i+1)
		}
	}
}

// Переполнение — обычный режим работы: буфер рассчитан на то, что новое
// значение затирает самое старое, и очищать его не требуется.
func TestBufferOverwritesOldest(t *testing.T) {
	buffer := NewBuffer(3)
	for i := 1; i <= 5; i++ {
		buffer.Add(point(i))
	}

	snapshot := buffer.Snapshot()
	if len(snapshot) != 3 {
		t.Fatalf("got %d points, want the buffer to stay at 3", len(snapshot))
	}

	want := []string{"3", "4", "5"}
	for i, p := range snapshot {
		if p.Price != want[i] {
			t.Errorf("point %d = %s, want %s", i, p.Price, want[i])
		}
	}
}

func TestBufferLengthNeverExceedsSize(t *testing.T) {
	buffer := NewBuffer(4)
	for i := 0; i < 1000; i++ {
		buffer.Add(point(i))
	}

	if got := buffer.Len(); got != 4 {
		t.Errorf("length = %d, want 4 regardless of how many points passed through", got)
	}
}

func TestBufferEmpty(t *testing.T) {
	if snapshot := NewBuffer(5).Snapshot(); len(snapshot) != 0 {
		t.Errorf("got %d points, want none", len(snapshot))
	}
}

// Между отправками хранится только последнее значение по активу:
// промежуточные котировки клиенту не нужны, он всё равно покажет последнюю.
func TestSubscriberKeepsOnlyLatestPerAsset(t *testing.T) {
	hub := NewHub(10)
	sub := hub.Subscribe(1, 2)

	hub.Publish(Tick{AssetID: 1, Symbol: "BTC", Price: "100", At: 1})
	hub.Publish(Tick{AssetID: 1, Symbol: "BTC", Price: "101", At: 2})
	hub.Publish(Tick{AssetID: 1, Symbol: "BTC", Price: "102", At: 3})
	hub.Publish(Tick{AssetID: 2, Symbol: "ETH", Price: "50", At: 3})

	ticks := sub.Drain()
	if len(ticks) != 2 {
		t.Fatalf("got %d ticks, want one per asset", len(ticks))
	}

	byAsset := map[int]string{}
	for _, tick := range ticks {
		byAsset[tick.AssetID] = tick.Price
	}
	if byAsset[1] != "102" {
		t.Errorf("BTC = %s, want the latest value 102", byAsset[1])
	}
	if byAsset[2] != "50" {
		t.Errorf("ETH = %s, want 50", byAsset[2])
	}
}

func TestDrainClearsPending(t *testing.T) {
	hub := NewHub(10)
	sub := hub.Subscribe(1)

	hub.Publish(Tick{AssetID: 1, Symbol: "BTC", Price: "100", At: 1})
	if len(sub.Drain()) != 1 {
		t.Fatal("first drain must return the pending tick")
	}
	if ticks := sub.Drain(); ticks != nil {
		t.Errorf("second drain returned %d ticks, want nothing new", len(ticks))
	}
}

// Котировки копятся в буфере независимо от того, смотрит ли кто-нибудь:
// подключившийся клиент сразу получает накопленное окно, а не пустой график.
func TestSnapshotAvailableWithoutSubscribers(t *testing.T) {
	hub := NewHub(10)
	hub.Publish(Tick{AssetID: 1, Symbol: "BTC", Price: "100", At: 1000})
	hub.Publish(Tick{AssetID: 1, Symbol: "BTC", Price: "101", At: 2000})

	if snapshot := hub.Snapshot(1); len(snapshot) != 2 {
		t.Errorf("got %d points, want 2", len(snapshot))
	}
	if snapshot := hub.Snapshot(99); snapshot != nil {
		t.Errorf("unknown asset returned %d points, want nothing", len(snapshot))
	}
}

// После отключения последнего зрителя актив перестаёт считаться
// просматриваемым: по этому списку сборщик решает, какие подписки
// держать на бирже.
func TestUnsubscribeStopsWatching(t *testing.T) {
	hub := NewHub(10)
	first := hub.Subscribe(1, 2)
	second := hub.Subscribe(1)

	if len(hub.Watched()) != 2 {
		t.Fatalf("watched = %v, want both assets", hub.Watched())
	}

	hub.Unsubscribe(first)
	if hub.SubscriberCount(1) != 1 {
		t.Errorf("BTC subscribers = %d, want the remaining one", hub.SubscriberCount(1))
	}
	if hub.SubscriberCount(2) != 0 {
		t.Errorf("ETH subscribers = %d, want none", hub.SubscriberCount(2))
	}

	hub.Unsubscribe(second)
	if watched := hub.Watched(); len(watched) != 0 {
		t.Errorf("watched = %v, want nothing after everyone left", watched)
	}
}

func TestPublishToAssetWithoutSubscribersDoesNotPanic(t *testing.T) {
	hub := NewHub(10)
	hub.Publish(Tick{AssetID: 42, Symbol: "SOL", Price: "140", At: 1})

	if hub.SubscriberCount(42) != 0 {
		t.Error("no one is subscribed, the count must stay zero")
	}
}

// Биржа публикует чаще, чем раз в секунду, но буфер рассчитан на то, что
// 900 значений — это 15 минут. Значит лишнее должно отбрасываться на входе.
func TestBufferThinsOutBurst(t *testing.T) {
	buffer := NewBuffer(900)

	start := time.Unix(1000, 0)
	for i := 0; i < 1200; i++ {
		buffer.Add(Point{At: start.Add(time.Duration(i) * 50 * time.Millisecond),
			Price: strconv.Itoa(i)})
	}

	// 1200 котировок с шагом 50 мс — это ровно минута.
	snapshot := buffer.Snapshot()
	if len(snapshot) != 60 {
		t.Fatalf("got %d points, want one per second over the minute", len(snapshot))
	}

	span := snapshot[len(snapshot)-1].At.Sub(snapshot[0].At)
	if span < 58*time.Second || span > 60*time.Second {
		t.Errorf("snapshot spans %s, want about a minute", span)
	}

	// Внутри секунды остаётся последнее значение, а не первое.
	if snapshot[1].Price != "39" {
		t.Errorf("second point = %s, want the last quote of that second", snapshot[1].Price)
	}
}

// Переставленные местами сообщения не должны затирать более свежую цену.
func TestBufferIgnoresStaleQuote(t *testing.T) {
	buffer := NewBuffer(10)
	buffer.Add(Point{At: time.Unix(100, 0), Price: "100"})
	buffer.Add(Point{At: time.Unix(99, 0), Price: "99"})

	snapshot := buffer.Snapshot()
	if len(snapshot) != 1 || snapshot[0].Price != "100" {
		t.Errorf("snapshot = %+v, want the newer quote kept", snapshot)
	}
}

// Пятнадцать минут при шаге в секунду должны укладываться в буфер целиком.
func TestBufferHoldsFifteenMinutes(t *testing.T) {
	buffer := NewBuffer(DefaultSize)

	start := time.Unix(1000, 0)
	for i := 0; i < 15*60; i++ {
		buffer.Add(Point{At: start.Add(time.Duration(i) * time.Second), Price: strconv.Itoa(i)})
	}

	snapshot := buffer.Snapshot()
	if len(snapshot) != 900 {
		t.Fatalf("got %d points, want 900", len(snapshot))
	}
	if span := snapshot[len(snapshot)-1].At.Sub(snapshot[0].At); span != 899*time.Second {
		t.Errorf("snapshot spans %s, want just under 15 minutes", span)
	}
}
