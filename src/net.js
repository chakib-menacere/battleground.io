export class Net {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.connect();
  }

  connect() {
    // Same-origin by default (local dev via the Vite proxy, or when the server also serves
    // the built client). Set VITE_WS_URL at build time to point at a separately hosted server
    // instead — needed when the client is deployed somewhere static-only, like GitHub Pages,
    // which can't run the WebSocket server itself.
    const configured = import.meta.env.VITE_WS_URL;
    let url;
    if (configured) {
      url = configured;
    } else {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${location.host}/ws`;
    }
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => this.handlers.onOpen?.());
    this.ws.addEventListener('close', () => {
      this.handlers.onClose?.();
      setTimeout(() => this.connect(), 1000);
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handlers.onMessage?.(msg);
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
