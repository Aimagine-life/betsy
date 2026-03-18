# Contributing to Betsy

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/meltymallow/betsy.git
cd betsy
npm install
cp betsy.config.yaml.example ~/.betsy/config.yaml
# Edit config with your API keys
npm run dev
```

## Commands

```bash
npm run dev          # Run dev server
npm run build:all    # Build backend + frontend
npm run typecheck    # TypeScript check
npm test             # Run tests
```

## How to Contribute

### Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Logs if applicable

### Suggesting Features

Open an issue describing:
- What problem it solves
- How you envision it working

### Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run typecheck` and `npm test`
4. Submit a PR with a clear description

## Code Style

- TypeScript, ESM modules
- Code and comments in English
- UI text in Russian
- Tools implement the `Tool` interface from `src/core/tools/types.ts`

## Project Structure

- `src/core/` — Engine, tools, LLM, memory, skills
- `src/channels/` — Telegram, browser channels
- `src/server.ts` — HTTP + WebSocket server
- `src/ui/` — React frontend

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
