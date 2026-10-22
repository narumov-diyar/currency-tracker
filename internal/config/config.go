// Пакет config читает настройки сервера из переменных окружения.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr            string
	DatabaseURL     string
	AuthSecret      string
	ShutdownTimeout time.Duration
	RollupInterval  time.Duration
}

// Короткий секрет сводит на нет подпись токенов, поэтому длина проверяется явно.
const minAuthSecretLength = 32

// Проход свёртки задаёт запаздывание пятиминутных свечей, поэтому
// согласован с частотой поступления минутных.
const defaultRollupInterval = time.Minute

// EnvFile — имя файла с настройками для разработки, лежащего рядом с проектом.
const EnvFile = ".env"

func Load() (Config, error) {
	if err := LoadEnvFile(EnvFile); err != nil {
		return Config{}, err
	}

	cfg := Config{
		Addr:            stringEnv("API_ADDR", ":8080"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		AuthSecret:      os.Getenv("AUTH_SECRET"),
		ShutdownTimeout: 10 * time.Second,
		RollupInterval:  defaultRollupInterval,
	}

	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is not set")
	}

	if len(cfg.AuthSecret) < minAuthSecretLength {
		return Config{}, fmt.Errorf("AUTH_SECRET must be at least %d characters", minAuthSecretLength)
	}

	if raw := os.Getenv("API_SHUTDOWN_TIMEOUT"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds <= 0 {
			return Config{}, fmt.Errorf("API_SHUTDOWN_TIMEOUT: expected positive number of seconds, got %q", raw)
		}
		cfg.ShutdownTimeout = time.Duration(seconds) * time.Second
	}

	if raw := os.Getenv("ROLLUP_INTERVAL"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds <= 0 {
			return Config{}, fmt.Errorf("ROLLUP_INTERVAL: expected positive number of seconds, got %q", raw)
		}
		cfg.RollupInterval = time.Duration(seconds) * time.Second
	}

	return cfg, nil
}

func stringEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
