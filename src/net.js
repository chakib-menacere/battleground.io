export class Net {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
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
