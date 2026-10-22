package httpapi

import (
	"bufio"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// statusRecorder запоминает код ответа: http.ResponseWriter его не отдаёт,
// а он нужен для записи в журнал.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

// Unwrap открывает доступ к исходному writer-у.
//
// Без него обёртка прячет возможности оригинала, и переключение протокола
// становится невозможным: WebSocket забирает соединение у HTTP-сервера
// напрямую, а обёртка такой запрос не пропускает. Первая же попытка
// подключиться к потоку отвечала 501.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("the underlying writer does not support hijacking")
	}
	return hijacker.Hijack()
}

// requestLogger пишет в STDOUT метод, путь, код и длительность каждого запроса.
// Длительность нужна, чтобы проверять требования ко времени отклика на работающем сервисе.
func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			started := time.Now()
			recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

			next.ServeHTTP(recorder, r)

			logger.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", recorder.status,
				"duration_ms", time.Since(started).Milliseconds(),
			)
		})
	}
}
