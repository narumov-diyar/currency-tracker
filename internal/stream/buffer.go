// Пакет stream отвечает за котировки в реальном времени: их хранение
// в памяти и рассылку подключённым клиентам.
package stream

import (
	"sync"
	"time"
)

// Окно реального времени — 15 минут с обновлением раз в секунду.
const DefaultSize = 900

// Step — шаг, с которым значения ложатся в буфер. Биржа публикует заметно
// чаще, но хранить всё подряд незачем: клиент и так получает не больше
// одного значения в секунду, а без прореживания 900 точек покрывали бы
// меньше минуты вместо пятнадцати.
const Step = time.Second

type Point struct {
	At    time.Time
	Price string
}

// Buffer хранит последние значения одного актива.
//
// Размер фиксирован, новое значение затирает самое старое. Благодаря этому
// очищать буфер не нужно вообще: память выделяется один раз при создании
// и дальше не растёт, сколько бы котировок ни прошло.
type Buffer struct {
	mu     sync.RWMutex
	points []Point
	next   int
	filled bool
	step   time.Duration
}

func NewBuffer(size int) *Buffer {
	if size <= 0 {
		size = DefaultSize
	}
	return &Buffer{points: make([]Point, size), step: Step}
}

// Add кладёт значение в буфер, прореживая поток до шага: котировка,
// пришедшая внутри того же шага, замещает предыдущую, а не добавляется.
// Пришедшая с временем раньше последней отбрасывается — биржа может
// переставить сообщения местами, и затирать свежую цену устаревшей нельзя.
func (b *Buffer) Add(point Point) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.next > 0 || b.filled {
		last := &b.points[(b.next-1+len(b.points))%len(b.points)]
		if point.At.Before(last.At) {
			return
		}
		// Сравниваются границы шага, а не разница времён: иначе каждая
		// следующая котировка отодвигала бы точку отсчёта на себя,
		// и в буфере навсегда осталось бы одно значение.
		if point.At.Truncate(b.step).Equal(last.At.Truncate(b.step)) {
			*last = point
			return
		}
	}

	b.points[b.next] = point
	b.next++
	if b.next == len(b.points) {
		b.next = 0
		b.filled = true
	}
}

// Snapshot отдаёт накопленные значения по возрастанию времени.
func (b *Buffer) Snapshot() []Point {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if !b.filled {
		return append([]Point(nil), b.points[:b.next]...)
	}

	// Кольцо развёрнуто: самое старое значение лежит сразу за точкой записи.
	result := make([]Point, 0, len(b.points))
	result = append(result, b.points[b.next:]...)
	return append(result, b.points[:b.next]...)
}

func (b *Buffer) Len() int {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if b.filled {
		return len(b.points)
	}
	return b.next
}
