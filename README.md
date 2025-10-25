# Peasant Brave macOS

Multi-stage GitHub Actions workflow for building Brave Browser on macOS.

## Usage

Edit `brave_version.txt` to set the version:

```bash
echo "1.85.74" > brave_version.txt
git add brave_version.txt
git commit -m "Build Brave 1.85.74"
git push
```

## How it works

- 8 sequential build stages, each saving/restoring state
- Uses `gtar` (GNU tar) for checkpoint compression
- Automatically resumes from last successful stage
- Final build artifact published to Releases

## Requirements

- GitHub repository with Actions enabled
- macOS runner (macos-latest)
- Node.js 24, Python 3.11
- Metal toolchain (auto-installed via xcodebuild)

## Build output

- `brave-out-{version}-macos.tar.xz` - Complete out directory with all build artifacts

## Technical details

- Build directory: `~/brave-build`
- Compression: gtar + zstd level 3
- Checkpoint retention: 1 day
- Final artifact retention: 7 days
- Max build time: ~15-24 hours (8 stages × 6 hours)

Based on peasant-brave-windows and peasant-brave-portablelinux multi-stage approach.

