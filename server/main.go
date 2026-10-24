// narra-desk 单文件二进制入口。
//
// 启动打印完整 URL `http://127.0.0.1:PORT/?token=XXXX`；
// token 一次性、进程退出即销毁（不落盘）。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8787", "监听地址（只应绑定回环）")
	webRoot := flag.String("webroot", "dist", "静态资源目录（vite build 产物）")
	fsRoot := flag.String("fsroot", "", "FS helper 工作区根；留空 = 关闭（默认）")
	upstream := flag.String("upstream", os.Getenv("NARRA_UPSTREAM"), "模型 API 基址，如 https://api.openai.com")
	flag.Parse()

	var upstreamURL *url.URL
	if *upstream != "" {
		u, err := url.Parse(*upstream)
		if err != nil || u.Scheme == "" || u.Host == "" {
			log.Fatalf("invalid -upstream: %q", *upstream)
		}
		upstreamURL = u
	}

	if _, err := os.Stat(*webRoot); err != nil {
		log.Printf("warning: webroot %q not found; static routes will 404 (run `npm run build` first)", *webRoot)
	}

	pairing, err := newPairingState()
	if err != nil {
		log.Fatalf("cannot generate pairing token: %v", err)
	}

	app := newApp(appConfig{
		WebRoot:     *webRoot,
		Upstream:    upstreamURL,
		UpstreamKey: os.Getenv("NARRA_API_KEY"),
		FSRoot:      *fsRoot,
	}, pairing)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen %s: %v", *addr, err)
	}

	srv := &http.Server{
		Handler:           app,
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       120 * time.Second,
		// 静态/代理都有各自的请求体上限；这里再兜一层
		MaxHeaderBytes: 1 << 20,
	}

	host := ln.Addr().String()
	// 浏览器访问用 127.0.0.1（[::1] 也过 Host 白名单）
	fmt.Printf("Narra Desk: http://%s/?token=%s\n", host, pairing.token)
	if upstreamURL != nil {
		fmt.Printf("proxy upstream: %s\n", upstreamURL)
	} else {
		fmt.Println("proxy upstream: (not configured — /v1/* will return 502)")
	}
	if *fsRoot != "" {
		fmt.Printf("fs helper: enabled at %s\n", *fsRoot)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
}
