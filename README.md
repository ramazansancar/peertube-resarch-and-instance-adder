# PeerTube Research & Instance Adder

Automated tool to discover and register PeerTube instances.

[Türkçe](README.tr.md)

## Features

- **Researcher**: Discovers new PeerTube instances from existing ones
- **Instance Adder**: Registers discovered instances to joinpeertube.org
- **Automated**: Runs daily via GitHub Actions

## How It Works

1. **Researcher** scans PeerTube instances and finds new ones
2. New instances are saved to `new-instances.txt`
3. **Instance Adder** registers them to joinpeertube.org

## Manual Usage

### Install Dependencies

```bash
pnpm install
```

### Run Researcher

```bash
# Without Redis (recommended for GitHub Actions)
node peertube-researcher.js

# With Redis (for local caching)
node peertube-researcher.js --use-redis
```

### Run Instance Adder

```bash
node peertube-instance-add.js
```

## GitHub Actions

Workflow runs automatically:

- **04:00 UTC**: Researcher discovers instances
- **06:00 UTC**: Instance Adder registers them

You can also run manually from the Actions tab.

## Configuration

Edit `config` object in the files:

- `concurrent`: Number of parallel requests
- `timeout`: Request timeout (ms)
- `testMode`: Enable test mode with limited instances

## Requirements

- Node.js 20+
- pnpm 8+
- Redis (optional, for local caching)

## Files

- `peertube-researcher.js`: Main discovery script
- `peertube-instance-add.js`: Registration script
- `new-instances.txt`: Discovered instances list
- `peertube-results-*.txt`: Registration results (artifacts only)

## License

MIT
