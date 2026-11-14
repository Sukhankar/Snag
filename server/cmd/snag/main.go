// Command snag is the Snag ingestion, triage and realtime server.
//
//	snag                       run the server
//	snag set-password <email>  set a user's password from $SNAG_NEW_PASSWORD (account recovery,
//	                           e.g. a locked-out owner) and sign them out everywhere
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/snag/server/internal/auth"
	"github.com/snag/server/internal/broker"
	"github.com/snag/server/internal/config"
	"github.com/snag/server/internal/db"
	"github.com/snag/server/internal/httpapi"
	"github.com/snag/server/internal/store"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	var err error
	if len(os.Args) > 1 && os.Args[1] == "set-password" {
		err = setPassword(os.Args[2:])
	} else {
		err = run()
	}
	if err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func setPassword(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: SNAG_NEW_PASSWORD=... snag set-password <email>")
	}
	pw := os.Getenv("SNAG_NEW_PASSWORD")
	if err := auth.ValidatePassword(pw); err != nil {
		return fmt.Errorf("SNAG_NEW_PASSWORD: %w", err)
	}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return errors.New("DATABASE_URL is required")
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	users := store.NewUserRepo(pool)
	u, _, err := users.UserForLogin(ctx, args[0])
	if err != nil {
		return fmt.Errorf("user %s: %w", args[0], err)
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	active, mustChange := true, false
	if _, err := users.UpdateUser(ctx, u.ID, store.UserPatch{PasswordHash: &hash, IsActive: &active, MustChange: &mustChange}, nil); err != nil {
		return err
	}
	fmt.Printf("password updated for %s (%s); all their sessions were signed out\n", u.Email, u.Name)
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	b := broker.New()
	api := httpapi.New(cfg, pool, b)
	if p, err := api.EnsureDemoProject(ctx); err != nil {
		return err
	} else if p != nil {
		slog.Info("demo project ready", "project_id", p.ID, "origins", p.AllowedOrigins)
	}
	switch created, err := api.EnsureOwner(ctx); {
	case err != nil:
		return fmt.Errorf("creating owner: %w", err)
	case created:
		slog.Info("owner account created", "email", cfg.OwnerEmail)
	default:
		if exists, _ := store.NewUserRepo(pool).OwnerExists(ctx); !exists {
			slog.Warn("no owner account yet: set SNAG_OWNER_EMAIL and SNAG_OWNER_PASSWORD and restart")
		}
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Routes(ctx),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second, // SSE handlers lift this per response
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("snag listening", "addr", cfg.Addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}

	slog.Info("shutting down")
	b.Close() // end SSE streams so Shutdown can drain
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
