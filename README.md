# battleground.io

A first-person 3D online multiplayer shooter, built with Three.js on the client and an
authoritative Node.js/WebSocket server. Valorant-inspired arena layout — two sites connected
by a walled mid lane, jump pads leading to elevated high ground, and a full economy/shop system
between lives.

**Play it:** https://chakib-menacere.github.io/battleground.io/

> Note: GitHub Pages only serves the static client. For full online multiplayer you need the
> WebSocket server running too — see [Running it yourself](#running-it-yourself) below.

## Features

- First-person movement: run, jump, crouch, and slide, with jump pads that launch you onto
  platforms unreachable by a normal jump
- Two weapon slots — a purchasable primary gun (rifle, pistol, or heavy rifle) and a free
  secondary knife with a slash and a one-hit backstab
- A shop in the lobby: buy weapons and armor with money earned from kills
- A door you hold **E** at to deploy from the lobby into the arena
- Ammo crates scattered around the map that refill your mag and reserve
- Third-person view (**F4**) with a fully animated character model — run, crouch, and slide
  poses driven by inverse kinematics, not just a static mesh
- Mobile touch controls and gamepad support alongside mouse/keyboard

## Controls

| Action | Key |
| --- | --- |
| Move | WASD |
| Look | Mouse |
| Shoot | Click |
| Jump | Space |
| Crouch / slide | Ctrl / C |
| Switch weapon / knife | 1 / 2 |
| Reload | R |
| Third person | F4 |
| Open shop (in lobby) | B |
| Deploy (hold, at the door) | E |
| Release cursor | Esc |

## Running it yourself

```bash
npm install
npm run dev:all   # runs the Vite client and the game server together
```

Then open the URL Vite prints (defaults to `http://localhost:5173`).

To run the client and server as separate processes:

```bash
npm run dev          # client only
npm run dev:server   # server only
```

## Tech stack

- **Client:** Three.js, vanilla JS, Vite
- **Server:** Node.js, `ws`, Express (serves the built client in production)
- Shared movement/physics code (`shared/`) is imported by both client and server, so
  client-side prediction and the server's authoritative simulation never disagree.
