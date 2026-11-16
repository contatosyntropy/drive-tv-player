# Drive TV Native Stream Player

This is the next-stage native playback experiment for LG webOS 6.x.

## What it tests

- Reads a preselected MKV from the Google Drive Worker using HTTP byte ranges.
- Uses FFmpeg's Matroska demuxer through a custom AVIO reader; the complete file is never downloaded or stored on the TV.
- Converts each HEVC packet to Annex-B with `hevc_mp4toannexb`.
- Sends HEVC access units to NDL DirectMedia v2 with source timestamps.
- Keeps audio and subtitle tracks disabled for this first streaming milestone.

The workflow writes `stream-url.txt` into the package. It currently points to the verified *The Great* S02E03 file in the configured Drive folder. The URL contains the same Google API key already used by the existing web app configuration; do not publish the generated package or URL publicly.

## Build

The GitHub Actions workflow cross-compiles a minimal static FFmpeg build for the webOS ARM target. Only Matroska demuxing, HEVC parsing, and the HEVC Annex-B bitstream filter are enabled. The app uses libcurl for ranged HTTP reads and FFmpeg's custom AVIO callbacks for seeking.

## Current limitations

- This is a controlled streaming test, not yet the finished folder-browsing player.
- The selected episode is fixed at build time.
- Audio is intentionally disabled. AC3/E-AC3 routing is a separate task.
- PGS subtitles are not rendered yet.
- Seeking UI, pause/resume, and error-code display still need implementation.
- Successful playback on the TV is required before treating this pipeline as validated.
