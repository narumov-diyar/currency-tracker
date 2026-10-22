package stream

import (
	"sync"
	"time"
)

type Tick struct {
	AssetID int    `json:"-"`
	Symbol  string `json:"symbol"`
	Price   string `json:"price"`
	At      int64  `json:"at"`
}

// Subscriber накапливает котировки между отправками.
//
// Хранится только последнее значение по каждому активу: клиенту незачем
// получать все промежуточные котировки, которые биржа успела прислать
// за секунду, — он всё равно покажет последнюю.
type Subscriber struct {
	assets []int

	mu      sync.Mutex
	pending map[int]Tick
}

func (s *Subscriber) push(tick Tick) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending[tick.AssetID] = tick
}

// Drain забирает накопленное и очищает его.
func (s *Subscriber) Drain() []Tick {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.pending) == 0 {
		return nil
	}

	ticks := make([]Tick, 0, len(s.pending))
	for _, tick := range s.pending {
		ticks = append(ticks, tick)
	}
	clear(s.pending)
	return ticks
}

type Hub struct {
	mu      sync.RWMutex
	buffers map[int]*Buffer
	subs    map[int]map[*Subscriber]struct{}
	size    int
}

func NewHub(bufferSize int) *Hub {
	return &Hub{
		buffers: make(map[int]*Buffer),
		subs:    make(map[int]map[*Subscriber]struct{}),
		size:    bufferSize,
	}
}

// Publish кладёт котировку в буфер актива и раздаёт её подписчикам.
func (h *Hub) Publish(tick Tick) {
	h.mu.Lock()
	buffer, ok := h.buffers[tick.AssetID]
	if !ok {
		buffer = NewBuffer(h.size)
		h.buffers[tick.AssetID] = buffer
	}
	subscribers := make([]*Subscriber, 0, len(h.subs[tick.AssetID]))
	for sub := range h.subs[tick.AssetID] {
		subscribers = append(subscribers, sub)
	}
	h.mu.Unlock()

	buffer.Add(Point{At: time.UnixMilli(tick.At), Price: tick.Price})

	for _, sub := range subscribers {
		sub.push(tick)
	}
}

func (h *Hub) Snapshot(assetID int) []Point {
	h.mu.RLock()
	buffer, ok := h.buffers[assetID]
	h.mu.RUnlock()

	if !ok {
		return nil
	}
	return buffer.Snapshot()
}

func (h *Hub) Subscribe(assets ...int) *Subscriber {
	sub := &Subscriber{assets: assets, pending: make(map[int]Tick, len(assets))}

	h.mu.Lock()
	defer h.mu.Unlock()
	for _, asset := range assets {
		if h.subs[asset] == nil {
			h.subs[asset] = make(map[*Subscriber]struct{})
		}
		h.subs[asset][sub] = struct{}{}
	}
	return sub
}

// Unsubscribe снимает подписку и убирает опустевшие записи, чтобы число
// отслеживаемых активов не росло по мере подключений.
func (h *Hub) Unsubscribe(sub *Subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, asset := range sub.assets {
		delete(h.subs[asset], sub)
		if len(h.subs[asset]) == 0 {
			delete(h.subs, asset)
		}
	}
}

// Watched перечисляет активы, которые сейчас кто-то смотрит.
// Сборщику этот список нужен, чтобы держать подписку на бирже только
// по ним: иначе входящий поток растёт по всему каталогу впустую.
func (h *Hub) Watched() []int {
	h.mu.RLock()
	defer h.mu.RUnlock()

	assets := make([]int, 0, len(h.subs))
	for asset := range h.subs {
		assets = append(assets, asset)
	}
	return assets
}

func (h *Hub) SubscriberCount(assetID int) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs[assetID])
}
